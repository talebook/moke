//! Extension package integrity, publisher trust and activation grants.
//!
//! `signature.json` is detached from the package digest. A successful signature
//! proves package integrity; publisher keys not already trusted still require a
//! high-risk activation confirmation. Grants are bound to the exact digest,
//! version, source and permission set so an old click cannot authorize changes.

use super::Manifest;
use base64::Engine;
use ring::{digest, signature};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const TRUST_FILE: &str = "trust.json";
const TRUST_TMP_FILE: &str = "trust.tmp";
const SIGNATURE_FILE: &str = "signature.json";
const SIGNATURE_CONTEXT: &str = "moke-extension-signature-v1";
const PACKAGE_CONTEXT: &[u8] = b"moke-extension-package-v1\0";
const MAX_PACKAGE_FILES: usize = 10_000;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;

// Publisher anchors are compiled into the signed Moke binary. Never promote a
// key merely because it appears in writable AppData: a same-user local process
// could otherwise edit trust.json and arrange arbitrary execution on restart.
// Release engineering provisions `(publisher_id, key_id, public_key_base64)`.
const BUILTIN_TRUSTED_KEYS: &[(&str, &str, &str)] = &[];

// Emergency denylist shipped with Moke releases. A revoked key is blocked even
// if it was trusted previously. Production key provisioning/revocation updates
// add `(publisher_id, key_id)` entries here without changing the package format.
const REVOKED_KEYS: &[(&str, &str)] = &[];

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrustEvaluation {
    pub signature_status: String,
    pub publisher_id: Option<String>,
    pub publisher_name: Option<String>,
    pub source: Option<String>,
    pub key_id: Option<String>,
    pub package_digest: String,
    pub trusted: bool,
    pub requires_approval: bool,
    pub blocked_reason: Option<String>,
    pub risks: Vec<String>,
    pub permissions_added: Vec<String>,
    pub permissions_removed: Vec<String>,
    pub upgrade_from: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DetachedSignature {
    schema_version: u32,
    algorithm: String,
    key_id: String,
    public_key: String,
    package_sha256: String,
    signature: String,
}

#[derive(Debug, Clone)]
struct VerifiedSignature {
    key_id: String,
    public_key: String,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct TrustStore {
    #[serde(default = "trust_schema_version")]
    schema_version: u32,
    #[serde(default)]
    publishers: HashMap<String, TrustedPublisher>,
    #[serde(default)]
    grants: HashMap<String, ExtensionGrant>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct TrustedPublisher {
    #[serde(default)]
    keys: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ExtensionGrant {
    version: String,
    package_digest: String,
    #[serde(default)]
    publisher_id: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    key_id: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    signed: bool,
}

fn trust_schema_version() -> u32 {
    1
}

impl Default for ExtensionGrant {
    fn default() -> Self {
        Self {
            version: String::new(),
            package_digest: String::new(),
            publisher_id: String::new(),
            source: String::new(),
            key_id: String::new(),
            permissions: Vec::new(),
            signed: false,
        }
    }
}

struct EvaluationResult {
    public: TrustEvaluation,
    verified: Option<VerifiedSignature>,
}

pub fn evaluate_installed(
    extensions_dir: &Path,
    ext_dir: &Path,
    manifest: &Manifest,
) -> TrustEvaluation {
    let store = load_store(extensions_dir);
    evaluate(ext_dir, manifest, &store).public
}

/// Re-evaluate immediately before activation and bind a matching explicit
/// approval to the current package. This digest check closes the UI/IPC TOCTOU
/// window: a confirmation for one package cannot enable different bytes.
pub fn authorize_activation(
    extensions_dir: &Path,
    ext_dir: &Path,
    manifest: &Manifest,
    approved_digest: Option<&str>,
) -> Result<TrustEvaluation, String> {
    let mut store = load_store(extensions_dir);
    let result = evaluate(ext_dir, manifest, &store);

    if let Some(reason) = &result.public.blocked_reason {
        return Err(format!("拓展安全校验阻断: {reason}"));
    }

    if result.public.requires_approval
        && approved_digest != Some(result.public.package_digest.as_str())
    {
        return Err(format!(
            "拓展需要重新确认发布者、来源或权限（package_digest={}）",
            result.public.package_digest
        ));
    }

    if result.public.requires_approval {
        let signed = result.verified.is_some();
        store.grants.insert(
            manifest.name.clone(),
            ExtensionGrant {
                version: manifest.version.clone(),
                package_digest: result.public.package_digest.clone(),
                publisher_id: manifest
                    .publisher
                    .as_ref()
                    .map(|publisher| publisher.id.clone())
                    .unwrap_or_default(),
                source: manifest
                    .publisher
                    .as_ref()
                    .map(|publisher| publisher.source.clone())
                    .unwrap_or_default(),
                key_id: result
                    .verified
                    .as_ref()
                    .map(|signature| signature.key_id.clone())
                    .unwrap_or_default(),
                permissions: sorted(manifest.permissions.clone()),
                signed,
            },
        );
        save_store(extensions_dir, &store)?;
    }

    Ok(result.public)
}

fn evaluate(ext_dir: &Path, manifest: &Manifest, store: &TrustStore) -> EvaluationResult {
    let package_digest = match package_digest(ext_dir) {
        Ok(digest) => digest,
        Err(error) => {
            return EvaluationResult {
                public: blocked_evaluation(
                    manifest,
                    String::new(),
                    "invalid",
                    format!("无法计算安全摘要: {error}"),
                ),
                verified: None,
            }
        }
    };

    let previous = store.grants.get(&manifest.name);
    let mut evaluation = TrustEvaluation {
        signature_status: "unsigned".into(),
        publisher_id: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.id.clone()),
        publisher_name: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.name.clone()),
        source: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.source.clone()),
        key_id: None,
        package_digest: package_digest.clone(),
        trusted: false,
        requires_approval: false,
        blocked_reason: None,
        risks: Vec::new(),
        permissions_added: permission_difference(
            &manifest.permissions,
            previous
                .map(|grant| grant.permissions.as_slice())
                .unwrap_or(&[]),
        ),
        permissions_removed: permission_difference(
            previous
                .map(|grant| grant.permissions.as_slice())
                .unwrap_or(&[]),
            &manifest.permissions,
        ),
        upgrade_from: previous.map(|grant| grant.version.clone()),
    };

    let verified = match verify_signature(ext_dir, manifest, &package_digest) {
        Ok(Some(signature)) => {
            evaluation.key_id = Some(signature.key_id.clone());
            match trusted_key(store, manifest, &signature) {
                Ok(true) => {
                    evaluation.signature_status = "trusted".into();
                    evaluation.trusted = true;
                }
                Ok(false) => {
                    evaluation.signature_status = "unknown_publisher".into();
                    evaluation
                        .risks
                        .push("签名有效，但发布者或轮换后的密钥尚未受信任".into());
                    evaluation.requires_approval = true;
                }
                Err(error) => {
                    evaluation.signature_status = "invalid".into();
                    evaluation.blocked_reason = Some(error);
                    return EvaluationResult {
                        public: evaluation,
                        verified: None,
                    };
                }
            }
            Some(signature)
        }
        Ok(None) => {
            if manifest
                .entry
                .as_ref()
                .and_then(|entry| entry.backend.as_ref())
                .is_some()
            {
                evaluation.blocked_reason =
                    Some("未签名的旧版拓展包含原生后端，Moke 不会执行该二进制".into());
                return EvaluationResult {
                    public: evaluation,
                    verified: None,
                };
            }
            evaluation
                .risks
                .push("旧版拓展未签名；仅允许在确认当前内容摘要后启用".into());
            evaluation.requires_approval = true;
            None
        }
        Err(error) => {
            evaluation.signature_status = "invalid".into();
            evaluation.blocked_reason = Some(format!("签名无效: {error}"));
            return EvaluationResult {
                public: evaluation,
                verified: None,
            };
        }
    };

    if let Some(previous) = previous {
        match compare_versions(&manifest.version, &previous.version) {
            std::cmp::Ordering::Less => {
                evaluation.blocked_reason = Some(format!(
                    "检测到版本降级/重放：已确认 {}，当前 {}",
                    previous.version, manifest.version
                ));
            }
            std::cmp::Ordering::Equal if previous.package_digest != package_digest => {
                evaluation.blocked_reason =
                    Some("相同版本的内容摘要发生变化；请由发布者提升版本后重新签名".into());
            }
            std::cmp::Ordering::Greater => {
                evaluation.risks.push(format!(
                    "版本将从 {} 升级到 {}",
                    previous.version, manifest.version
                ));
                evaluation.requires_approval = true;
            }
            _ => {}
        }

        let current_publisher = manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.id.as_str())
            .unwrap_or("");
        let current_source = manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.source.as_str())
            .unwrap_or("");
        if previous.publisher_id != current_publisher {
            evaluation.risks.push(format!(
                "发布者从「{}」变更为「{}」",
                display_or_unknown(&previous.publisher_id),
                display_or_unknown(current_publisher)
            ));
            evaluation.requires_approval = true;
        }
        if previous.source != current_source {
            evaluation.risks.push(format!(
                "来源从「{}」变更为「{}」",
                display_or_unknown(&previous.source),
                display_or_unknown(current_source)
            ));
            evaluation.requires_approval = true;
        }
        if !evaluation.permissions_added.is_empty() {
            evaluation.risks.push(format!(
                "新增权限：{}",
                evaluation.permissions_added.join("、")
            ));
            evaluation.requires_approval = true;
        }

        let unchanged = previous.package_digest == package_digest
            && previous.version == manifest.version
            && previous.publisher_id == current_publisher
            && previous.source == current_source
            && previous.permissions == sorted(manifest.permissions.clone())
            && previous.signed == verified.is_some();
        if unchanged && evaluation.blocked_reason.is_none() {
            evaluation.requires_approval = !evaluation.trusted && previous.signed;
            if !previous.signed {
                evaluation.requires_approval = false;
            }
        }
    } else {
        evaluation
            .risks
            .push("首次启用需要确认发布者、来源和全部权限".into());
        evaluation.requires_approval = true;
    }

    if evaluation.blocked_reason.is_some() {
        evaluation.requires_approval = false;
    }

    EvaluationResult {
        public: evaluation,
        verified,
    }
}

fn blocked_evaluation(
    manifest: &Manifest,
    package_digest: String,
    status: &str,
    reason: String,
) -> TrustEvaluation {
    TrustEvaluation {
        signature_status: status.into(),
        publisher_id: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.id.clone()),
        publisher_name: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.name.clone()),
        source: manifest
            .publisher
            .as_ref()
            .map(|publisher| publisher.source.clone()),
        key_id: None,
        package_digest,
        trusted: false,
        requires_approval: false,
        blocked_reason: Some(reason),
        risks: Vec::new(),
        permissions_added: manifest.permissions.clone(),
        permissions_removed: Vec::new(),
        upgrade_from: None,
    }
}

fn verify_signature(
    ext_dir: &Path,
    manifest: &Manifest,
    package_digest: &str,
) -> Result<Option<VerifiedSignature>, String> {
    let signature_path = ext_dir.join(SIGNATURE_FILE);
    if !signature_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&signature_path)
        .map_err(|error| format!("无法读取 signature.json: {error}"))?;
    if raw.len() > 32 * 1024 {
        return Err("signature.json 过大".into());
    }
    let detached: DetachedSignature =
        serde_json::from_str(&raw).map_err(|error| format!("signature.json 解析失败: {error}"))?;
    if detached.schema_version != 1 || detached.algorithm != "ed25519" {
        return Err("仅支持 schema_version=1 和 ed25519".into());
    }
    if detached.package_sha256 != package_digest {
        return Err("包内容摘要与签名记录不一致（文件可能已被篡改）".into());
    }
    validate_key_id(&detached.key_id)?;
    let publisher = manifest
        .publisher
        .as_ref()
        .ok_or_else(|| "已签名拓展必须在 manifest 声明 publisher".to_string())?;
    if REVOKED_KEYS.contains(&(publisher.id.as_str(), detached.key_id.as_str())) {
        return Err(format!(
            "发布者「{}」的签名密钥「{}」已撤销",
            publisher.id, detached.key_id
        ));
    }
    let public_key = base64::engine::general_purpose::STANDARD
        .decode(&detached.public_key)
        .map_err(|_| "public_key 不是有效 Base64".to_string())?;
    if public_key.len() != 32 {
        return Err("Ed25519 public_key 必须为 32 字节".into());
    }
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&detached.signature)
        .map_err(|_| "signature 不是有效 Base64".to_string())?;
    if signature_bytes.len() != 64 {
        return Err("Ed25519 signature 必须为 64 字节".into());
    }
    let payload = signature_payload(manifest, &detached.key_id, package_digest);
    signature::UnparsedPublicKey::new(&signature::ED25519, &public_key)
        .verify(payload.as_bytes(), &signature_bytes)
        .map_err(|_| "Ed25519 验证失败".to_string())?;

    if publisher.id.trim().is_empty() {
        return Err("publisher.id 不能为空".into());
    }
    Ok(Some(VerifiedSignature {
        key_id: detached.key_id,
        public_key: detached.public_key,
    }))
}

fn trusted_key(
    _store: &TrustStore,
    manifest: &Manifest,
    signature: &VerifiedSignature,
) -> Result<bool, String> {
    let Some(publisher) = &manifest.publisher else {
        return Ok(false);
    };
    let trusted = BUILTIN_TRUSTED_KEYS
        .iter()
        .find(|(publisher_id, key_id, _)| {
            *publisher_id == publisher.id && *key_id == signature.key_id
        });
    let Some((_, _, public_key)) = trusted else {
        return Ok(false);
    };
    if *public_key != signature.public_key {
        return Err(format!(
            "发布者「{}」的 key_id「{}」发生密钥替换",
            publisher.id, signature.key_id
        ));
    }
    Ok(true)
}

fn signature_payload(manifest: &Manifest, key_id: &str, package_digest: &str) -> String {
    let publisher = manifest.publisher.as_ref();
    format!(
        "{SIGNATURE_CONTEXT}\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.name,
        manifest.version,
        publisher.map(|value| value.id.as_str()).unwrap_or(""),
        publisher.map(|value| value.source.as_str()).unwrap_or(""),
        key_id,
        package_digest
    )
}

fn package_digest(ext_dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect_package_files(ext_dir, ext_dir, &mut files, 0)?;
    files.sort();

    let mut package = digest::Context::new(&digest::SHA256);
    package.update(PACKAGE_CONTEXT);
    let mut package_bytes = 0u64;
    for relative in files {
        let full_path = ext_dir.join(&relative);
        let file_bytes = std::fs::metadata(&full_path)
            .map_err(|error| format!("无法读取 {} 元数据: {error}", relative.display()))?
            .len();
        package_bytes = package_bytes
            .checked_add(file_bytes)
            .ok_or_else(|| "拓展包大小溢出".to_string())?;
        if package_bytes > MAX_PACKAGE_BYTES {
            return Err("拓展包超过 1 GiB 安全上限".into());
        }
        let mut file = File::open(&full_path)
            .map_err(|error| format!("无法读取 {}: {error}", relative.display()))?;
        let mut file_digest = digest::Context::new(&digest::SHA256);
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("无法读取 {}: {error}", relative.display()))?;
            if read == 0 {
                break;
            }
            file_digest.update(&buffer[..read]);
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        package.update(relative.as_bytes());
        package.update(b"\0");
        package.update(file_digest.finish().as_ref());
        package.update(b"\n");
    }
    Ok(hex(package.finish().as_ref()))
}

fn collect_package_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("拓展包目录深度超过 32 层".into());
    }
    let entries = std::fs::read_dir(current)
        .map_err(|error| format!("无法扫描 {}: {error}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取目录项: {error}"))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("无法读取 {} 元数据: {error}", path.display()))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "拓展文件逃逸出安装目录".to_string())?
            .to_path_buf();
        if metadata.file_type().is_symlink() {
            return Err(format!("拓展包不允许符号链接: {}", relative.display()));
        }
        if metadata.is_dir() {
            collect_package_files(root, &path, files, depth + 1)?;
        } else if metadata.is_file() && !is_host_mutable_file(&relative) {
            files.push(relative);
            if files.len() > MAX_PACKAGE_FILES {
                return Err(format!("拓展包文件数超过 {MAX_PACKAGE_FILES}"));
            }
        }
    }
    Ok(())
}

fn is_host_mutable_file(relative: &Path) -> bool {
    if relative.components().count() != 1 {
        return false;
    }
    let name = relative.to_string_lossy().to_ascii_lowercase();
    matches!(
        name.as_str(),
        SIGNATURE_FILE | "storage.json" | "uninstall.exe" | "installer.nsi"
    ) || name.ends_with("-setup.exe")
}

fn load_store(extensions_dir: &Path) -> TrustStore {
    let path = extensions_dir.join(TRUST_FILE);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return TrustStore {
            schema_version: trust_schema_version(),
            ..TrustStore::default()
        };
    };
    match serde_json::from_str(&raw) {
        Ok(store) => store,
        Err(error) => {
            log::warn!("拓展信任记录损坏，将要求重新确认: {error}");
            TrustStore {
                schema_version: trust_schema_version(),
                ..TrustStore::default()
            }
        }
    }
}

fn save_store(extensions_dir: &Path, store: &TrustStore) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store)
        .map_err(|error| format!("序列化拓展信任记录失败: {error}"))?;
    let temporary = extensions_dir.join(TRUST_TMP_FILE);
    let target = extensions_dir.join(TRUST_FILE);
    std::fs::write(&temporary, json).map_err(|error| format!("写入拓展信任记录失败: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, &target) {
        if target.exists() {
            std::fs::remove_file(&target)
                .map_err(|remove_error| format!("替换拓展信任记录失败: {remove_error}"))?;
            std::fs::rename(&temporary, &target)
                .map_err(|rename_error| format!("替换拓展信任记录失败: {rename_error}"))?;
        } else {
            return Err(format!("保存拓展信任记录失败: {error}"));
        }
    }
    Ok(())
}

fn permission_difference(left: &[String], right: &[String]) -> Vec<String> {
    let mut values: Vec<String> = left
        .iter()
        .filter(|permission| !right.contains(permission))
        .cloned()
        .collect();
    values.sort();
    values.dedup();
    values
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |version: &str| -> [u64; 3] {
        let mut parts = version
            .split('.')
            .take(3)
            .map(|part| part.parse::<u64>().unwrap_or(0));
        [
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        ]
    };
    parse(left).cmp(&parse(right))
}

fn validate_key_id(key_id: &str) -> Result<(), String> {
    if key_id.is_empty()
        || key_id.len() > 64
        || !key_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("key_id 只能包含字母、数字、连字符和下划线，且不超过 64 字符".into());
    }
    Ok(())
}

fn display_or_unknown(value: &str) -> &str {
    if value.is_empty() {
        "未知"
    } else {
        value
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{BackendConfig, EntryConfig, PublisherConfig};
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn fixture_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("moke-trust-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn manifest(version: &str, permissions: &[&str], backend: bool) -> Manifest {
        Manifest {
            name: "sample-extension".into(),
            version: version.into(),
            api_version: "1".into(),
            display_name: "Sample".into(),
            description: String::new(),
            author: String::new(),
            publisher: Some(PublisherConfig {
                id: "org.example".into(),
                name: "Example".into(),
                source: "https://example.org/extensions/sample-extension".into(),
            }),
            entry: backend.then(|| EntryConfig {
                ui_port: 0,
                backend: Some(BackendConfig {
                    executable: "backend.exe".into(),
                    args: Vec::new(),
                }),
            }),
            sidebar: None,
            permissions: permissions.iter().map(|value| (*value).into()).collect(),
            lucide_icons: Vec::new(),
        }
    }

    fn write_manifest(ext_dir: &Path, manifest: &Manifest) {
        let value = serde_json::json!({
            "name": manifest.name,
            "version": manifest.version,
            "api_version": manifest.api_version,
            "display_name": manifest.display_name,
            "publisher": manifest.publisher.as_ref().map(|publisher| serde_json::json!({
                "id": publisher.id,
                "name": publisher.name,
                "source": publisher.source,
            })),
            "permissions": manifest.permissions,
        });
        std::fs::write(
            ext_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    fn key_pair() -> Ed25519KeyPair {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap()
    }

    fn sign(ext_dir: &Path, manifest: &Manifest, key_id: &str, key_pair: &Ed25519KeyPair) {
        let package_sha256 = package_digest(ext_dir).unwrap();
        let payload = signature_payload(manifest, key_id, &package_sha256);
        let signature = key_pair.sign(payload.as_bytes());
        let detached = serde_json::json!({
            "schema_version": 1,
            "algorithm": "ed25519",
            "key_id": key_id,
            "public_key": base64::engine::general_purpose::STANDARD.encode(key_pair.public_key().as_ref()),
            "package_sha256": package_sha256,
            "signature": base64::engine::general_purpose::STANDARD.encode(signature.as_ref()),
        });
        std::fs::write(
            ext_dir.join(SIGNATURE_FILE),
            serde_json::to_vec_pretty(&detached).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn valid_unknown_signature_requires_approval_each_session() {
        let root = fixture_dir("valid");
        let ext_dir = root.join("sample-extension");
        std::fs::create_dir(&ext_dir).unwrap();
        let manifest = manifest("1.0.0", &["storage"], false);
        write_manifest(&ext_dir, &manifest);
        let key = key_pair();
        sign(&ext_dir, &manifest, "key-1", &key);

        let first = evaluate_installed(&root, &ext_dir, &manifest);
        assert_eq!(first.signature_status, "unknown_publisher");
        assert!(first.requires_approval);
        authorize_activation(&root, &ext_dir, &manifest, Some(&first.package_digest)).unwrap();

        let second = evaluate_installed(&root, &ext_dir, &manifest);
        assert_eq!(second.signature_status, "unknown_publisher");
        assert!(second.requires_approval);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tampering_and_same_version_repack_are_blocked() {
        let root = fixture_dir("tamper");
        let ext_dir = root.join("sample-extension");
        std::fs::create_dir(&ext_dir).unwrap();
        let manifest = manifest("1.0.0", &["storage"], false);
        write_manifest(&ext_dir, &manifest);
        std::fs::write(ext_dir.join("ui.js"), "safe").unwrap();
        let key = key_pair();
        sign(&ext_dir, &manifest, "key-1", &key);
        let first = evaluate_installed(&root, &ext_dir, &manifest);
        authorize_activation(&root, &ext_dir, &manifest, Some(&first.package_digest)).unwrap();

        std::fs::write(ext_dir.join("ui.js"), "tampered").unwrap();
        let tampered = evaluate_installed(&root, &ext_dir, &manifest);
        assert_eq!(tampered.signature_status, "invalid");
        assert!(tampered.blocked_reason.is_some());

        sign(&ext_dir, &manifest, "key-1", &key);
        let repacked = evaluate_installed(&root, &ext_dir, &manifest);
        assert!(repacked
            .blocked_reason
            .as_deref()
            .unwrap()
            .contains("相同版本"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotation_upgrade_permission_expansion_and_downgrade_are_gated() {
        let root = fixture_dir("rotation");
        let ext_dir = root.join("sample-extension");
        std::fs::create_dir(&ext_dir).unwrap();
        let key_one = key_pair();
        let key_two = key_pair();
        let first_manifest = manifest("1.0.0", &["storage"], false);
        write_manifest(&ext_dir, &first_manifest);
        sign(&ext_dir, &first_manifest, "key-1", &key_one);
        let first = evaluate_installed(&root, &ext_dir, &first_manifest);
        authorize_activation(
            &root,
            &ext_dir,
            &first_manifest,
            Some(&first.package_digest),
        )
        .unwrap();

        let upgraded = manifest("2.0.0", &["storage", "reader.command.send"], false);
        write_manifest(&ext_dir, &upgraded);
        sign(&ext_dir, &upgraded, "key-2", &key_two);
        let rotation = evaluate_installed(&root, &ext_dir, &upgraded);
        assert_eq!(rotation.signature_status, "unknown_publisher");
        assert_eq!(rotation.permissions_added, vec!["reader.command.send"]);
        assert!(rotation.requires_approval);
        authorize_activation(&root, &ext_dir, &upgraded, Some(&rotation.package_digest)).unwrap();

        write_manifest(&ext_dir, &first_manifest);
        sign(&ext_dir, &first_manifest, "key-1", &key_one);
        let downgrade = evaluate_installed(&root, &ext_dir, &first_manifest);
        assert!(downgrade
            .blocked_reason
            .as_deref()
            .unwrap()
            .contains("降级"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsigned_legacy_ui_needs_confirmation_but_native_backend_is_blocked() {
        let root = fixture_dir("legacy");
        let ext_dir = root.join("sample-extension");
        std::fs::create_dir(&ext_dir).unwrap();
        let ui_manifest = manifest("1.0.0", &[], false);
        write_manifest(&ext_dir, &ui_manifest);
        let ui = evaluate_installed(&root, &ext_dir, &ui_manifest);
        assert_eq!(ui.signature_status, "unsigned");
        assert!(ui.requires_approval);
        assert!(ui.blocked_reason.is_none());

        let backend_manifest = manifest("1.0.0", &[], true);
        let backend = evaluate_installed(&root, &ext_dir, &backend_manifest);
        assert!(backend
            .blocked_reason
            .as_deref()
            .unwrap()
            .contains("原生后端"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_change_requires_a_new_digest_bound_confirmation() {
        let root = fixture_dir("source");
        let ext_dir = root.join("sample-extension");
        std::fs::create_dir(&ext_dir).unwrap();
        let key = key_pair();
        let first_manifest = manifest("1.0.0", &["storage"], false);
        write_manifest(&ext_dir, &first_manifest);
        sign(&ext_dir, &first_manifest, "key-1", &key);
        let first = evaluate_installed(&root, &ext_dir, &first_manifest);
        authorize_activation(
            &root,
            &ext_dir,
            &first_manifest,
            Some(&first.package_digest),
        )
        .unwrap();

        let mut moved = manifest("2.0.0", &["storage"], false);
        moved.publisher.as_mut().unwrap().source =
            "https://mirror.example.org/extensions/sample-extension".into();
        write_manifest(&ext_dir, &moved);
        sign(&ext_dir, &moved, "key-1", &key);
        let evaluation = evaluate_installed(&root, &ext_dir, &moved);
        assert!(evaluation.requires_approval);
        assert!(evaluation.risks.iter().any(|risk| risk.contains("来源")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
