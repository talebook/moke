//! ZIP import: untrusted bytes -> private staging -> review -> journaled rename.
//! A global operation lock serializes import/enable/disable/uninstall. Old trees
//! are retained, never executed as uninstallers. Same-user OS compromise remains
//! outside the protection of filesystem permissions (see extension-zip.md).
use super::{discovery, lifecycle, package_path, trust, ExtensionInfo, ExtensionRuntime, Manifest};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 10_000;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_ZIP: u64 = 512 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Installer {
    pending: Option<Pending>,
}
struct Pending {
    token: String,
    directory: tempfile::TempDir,
    digest: String,
    signature: Option<Vec<u8>>,
    installed: Option<String>,
    created: Instant,
}
#[derive(serde::Serialize)]
pub(super) struct Preview {
    pub ticket: String,
    pub extension: ExtensionInfo,
}

/// One cooperating Moke process owns this extension root for its lifetime.
/// Advisory locking does not defend against a hostile same-user process.
pub(super) fn lock_directory(root: &Path) -> Result<File, String> {
    use fs4::fs_std::FileExt;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".host-lock"))
        .map_err(err)?;
    if !file.try_lock_exclusive().map_err(err)? {
        return Err("另一个 Moke 实例正在管理这些扩展，请关闭该实例后重启".into());
    }
    Ok(file)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Bound central-directory metadata before ZipArchive allocates its index.
/// ZIP64/multi-disk/SFX are unnecessary under our limits and intentionally rejected.
fn preflight(reader: &mut File) -> Result<usize, String> {
    let mut magic = [0; 4];
    reader.read_exact(&mut magic).map_err(err)?;
    if &magic != b"PK\x03\x04" {
        return Err("ZIP 必须从标准文件头开始，不支持自解压格式".into());
    }
    let length = reader.metadata().map_err(err)?.len();
    if length > MAX_ZIP {
        return Err("ZIP 超过 512 MiB，请缩小包内容".into());
    }
    let tail_size = length.min(65557) as usize;
    reader
        .seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(err)?;
    let mut tail = vec![0; tail_size];
    reader.read_exact(&mut tail).map_err(err)?;
    let offset = (0..tail_size.saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize == tail.len()
        })
        .ok_or("ZIP 结束目录无效")?;
    let e = &tail[offset..];
    let u16_at = |i| u16::from_le_bytes([e[i], e[i + 1]]);
    let u32_at = |i| u32::from_le_bytes(e[i..i + 4].try_into().unwrap());
    let count = u16_at(10) as usize;
    let size = u32_at(12) as u64;
    let start = u32_at(16) as u64;
    if u16_at(4) != 0
        || u16_at(6) != 0
        || u16_at(8) as usize != count
        || count == 0
        || count > MAX_ENTRIES
        || size > 16 * 1024 * 1024
        || start + size != length - tail_size as u64 + offset as u64
    {
        return Err("ZIP 条目数/目录大小超限，或使用不支持的 ZIP64/分卷格式".into());
    }
    reader.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut names = HashSet::new();
    for _ in 0..count {
        let mut h = [0; 46];
        reader.read_exact(&mut h).map_err(err)?;
        if &h[..4] != b"PK\x01\x02" {
            return Err("ZIP 中央目录无效".into());
        }
        let name_size = u16::from_le_bytes([h[28], h[29]]) as usize;
        let extra_size = u16::from_le_bytes([h[30], h[31]]) as usize;
        let comment_size = u16::from_le_bytes([h[32], h[33]]) as usize;
        if name_size > 1025 {
            return Err("ZIP 名称过长".into());
        }
        let mut name = vec![0; name_size];
        reader.read_exact(&mut name).map_err(err)?;
        if !names.insert(name) {
            return Err("ZIP 包含重复条目".into());
        }
        reader
            .seek(SeekFrom::Current((extra_size + comment_size) as i64))
            .map_err(err)?;
        if reader.stream_position().map_err(err)? > start + size {
            return Err("ZIP 中央目录越界".into());
        }
    }
    if reader.stream_position().map_err(err)? != start + size {
        return Err("ZIP 条目计数不一致".into());
    }
    reader.rewind().map_err(err)?;
    Ok(count)
}

/// Only ordinary UTF-8 files/directories are supported. ZIP has no portable hard
/// link representation: reject Unix link metadata extra fields rather than
/// interpreting them. Every written byte is counted, regardless of header sizes.
fn extract(mut reader: File, target: &Path, max_file: u64, max_total: u64) -> Result<(), String> {
    let expected_entries = preflight(&mut reader)?;
    let mut zip =
        zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 无法读取（不支持加密包）: {e}"))?;
    if zip.len() != expected_entries || zip.len() > MAX_ENTRIES {
        return Err("ZIP 条目数超过 10000".into());
    }
    let mut names = HashSet::new();
    let mut components = HashMap::new();
    let mut total = 0;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(err)?;
        let raw = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "ZIP 名称必须为 UTF-8")?
            .to_owned();
        let is_dir = raw.ends_with('/');
        let name = if is_dir { &raw[..raw.len() - 1] } else { &raw };
        package_path::validate(name)?;
        if package_path::reserved_root(name) {
            return Err(format!("ZIP 不能包含宿主状态或旧安装器: {name}"));
        }
        if !names.insert(name.to_uppercase()) {
            return Err(format!("ZIP 重复条目或大小写碰撞: {name}"));
        }
        let mut prefix = String::new();
        let parts: Vec<_> = name.split('/').collect();
        for (i, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let dir = i + 1 < parts.len() || is_dir;
            if let Some((prior, prior_dir)) =
                components.insert(prefix.to_uppercase(), (prefix.clone(), dir))
            {
                if prior != prefix || prior_dir != dir {
                    return Err(format!("ZIP 路径规范化碰撞: {name}"));
                }
            }
        }
        let mode = entry
            .unix_mode()
            .unwrap_or(if is_dir { 0o040755 } else { 0o100644 });
        if (mode & 0o170000) != if is_dir { 0o040000 } else { 0o100000 } {
            return Err(format!("ZIP 不允许链接或特殊文件: {name}"));
        }
        // Only timestamp/UID/GID/ZIP64/Unicode path extras are accepted. Unknown
        // extensions can encode links (0x000d/0x5855/0x756e) and are rejected.
        let extra = entry.extra_data().unwrap_or(&[]);
        let mut offset = 0;
        while offset < extra.len() {
            if offset + 4 > extra.len() {
                return Err("ZIP extra field 无效".into());
            }
            let id = u16::from_le_bytes([extra[offset], extra[offset + 1]]);
            let size = u16::from_le_bytes([extra[offset + 2], extra[offset + 3]]) as usize;
            if ![0x0001, 0x5455, 0x7875].contains(&id) || offset + 4 + size > extra.len() {
                return Err(format!(
                    "ZIP 包含不支持的扩展元数据 {id:04x}，请用 moke-ext package 重新打包"
                ));
            }
            offset += 4 + size;
        }
        let dest = target.join(name);
        if is_dir {
            if entry.size() != 0 {
                return Err("ZIP 目录不能携带数据".into());
            }
            fs::create_dir_all(dest).map_err(err)?;
            continue;
        }
        fs::create_dir_all(dest.parent().unwrap()).map_err(err)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&dest).map_err(err)?;
        let mut written = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|e| format!("ZIP 解压/CRC 校验失败: {e}"))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            total += n as u64;
            if written > max_file || total > max_total {
                return Err("ZIP 实际解压字节超限（单文件 256 MiB / 总计 1 GiB）".into());
            }
            file.write_all(&buffer[..n]).map_err(err)?;
        }
        file.sync_all().map_err(err)?;
    }
    if !target.join("manifest.json").is_file() {
        return Err("ZIP 根目录必须直接包含 manifest.json，不能套一层文件夹".into());
    }
    sync_tree_directories(target)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path).and_then(|f| f.sync_all()).map_err(err)?;
    #[cfg(not(unix))]
    let _ = path; // Windows directory flush guarantees depend on filesystem/OS.
    Ok(())
}
fn sync_tree_directories(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.file_type().map_err(err)?.is_dir() {
            sync_tree_directories(&entry.path())?;
        }
    }
    sync_directory(path)
}

pub(super) fn check_platform(manifest: &Manifest) -> Result<(), String> {
    if let Some(backend) = manifest.entry.as_ref().and_then(|e| e.backend.as_ref()) {
        let actual = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        if !backend.targets.iter().any(|target| target == &actual) {
            return Err(format!("原生后端不支持当前平台 {actual}；请作者在 entry.backend.targets 声明并提供对应二进制（旧扩展需重新打包）"));
        }
    }
    Ok(())
}

/// Validate the executable container as well as the signed target declaration.
/// Scripts are intentionally unsupported; the OS loader never sees a wrong-arch file.
pub(super) fn validate_binary(root: &Path, backend: &super::BackendConfig) -> Result<(), String> {
    let actual = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    if !backend.targets.contains(&actual) {
        return Err(format!("后端 targets 不支持 {actual}，请重新打包"));
    }
    let mut bytes = Vec::new();
    File::open(root.join(&backend.executable))
        .map_err(|e| format!("后端文件缺失: {e}"))?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    let supports = binary_targets(&bytes);
    if !supports.contains(&actual) {
        return Err(format!(
            "后端二进制格式/架构与当前平台 {actual} 不符（检测到 {supports:?}）"
        ));
    }
    Ok(())
}
fn binary_targets(b: &[u8]) -> Vec<String> {
    let mut result = Vec::new();
    let arch = |machine, x64, arm| {
        if machine == x64 {
            Some("x86_64")
        } else if machine == arm {
            Some("aarch64")
        } else {
            None
        }
    };
    if b.len() >= 20 && &b[..4] == b"\x7fELF" && b[4] == 2 && b[5] == 1 {
        if let Some(a) = arch(u32::from(u16::from_le_bytes([b[18], b[19]])), 62, 183) {
            result.push(format!("linux-{a}"));
        }
    } else if b.len() >= 64 && &b[..2] == b"MZ" {
        let offset = u32::from_le_bytes(b[60..64].try_into().unwrap()) as usize;
        if let Some(header) = b.get(offset..offset.saturating_add(6)) {
            if &header[..4] == b"PE\0\0" {
                if let Some(a) = arch(
                    u32::from(u16::from_le_bytes([header[4], header[5]])),
                    0x8664,
                    0xaa64,
                ) {
                    result.push(format!("windows-{a}"));
                }
            }
        }
    } else if b.len() >= 8 {
        if b[..4] == [0xcf, 0xfa, 0xed, 0xfe] {
            if let Some(a) = arch(
                u32::from_le_bytes(b[4..8].try_into().unwrap()),
                0x01000007,
                0x0100000c,
            ) {
                result.push(format!("macos-{a}"));
            }
        } else if b[..4] == [0xca, 0xfe, 0xba, 0xbe] || b[..4] == [0xca, 0xfe, 0xba, 0xbf] {
            let count = u32::from_be_bytes(b[4..8].try_into().unwrap()).min(16) as usize;
            let stride = if b[3] == 0xbf { 32 } else { 20 };
            for i in 0..count {
                if let Some(cpu) = b.get(8 + i * stride..12 + i * stride) {
                    if let Some(a) = arch(
                        u32::from_be_bytes(cpu.try_into().unwrap()),
                        0x01000007,
                        0x0100000c,
                    ) {
                        result.push(format!("macos-{a}"));
                    }
                }
            }
        }
    }
    result
}

/// Compatibility input for authors migrating private files out of package roots.
/// Copy required data during startup; the transaction path may move after commit.
pub(super) fn legacy_directory(ext_dir: &Path) -> Option<std::path::PathBuf> {
    let root = ext_dir.parent()?;
    let name = ext_dir.file_name()?;
    let transaction = root.join(".transaction/old");
    if transaction.is_dir() {
        return Some(transaction);
    }
    fs::read_dir(root.join(".previous").join(name))
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .max_by_key(|entry| entry.metadata().ok().and_then(|m| m.modified().ok()))
        .map(|entry| entry.path())
}

fn installed_digest(root: &Path, name: &str) -> Result<Option<String>, String> {
    let directory = root.join(name);
    if directory.exists() {
        trust::package_digest(&directory).map(Some)
    } else {
        Ok(None)
    }
}
fn evaluate(root: &Path, directory: &Path) -> Result<ExtensionInfo, String> {
    let manifest = discovery::read_and_validate_manifest(&directory.join("manifest.json"))?;
    check_platform(&manifest)?;
    if let Some(backend) = manifest.entry.as_ref().and_then(|e| e.backend.as_ref()) {
        validate_binary(directory, backend)?;
    }
    let mut evaluation = trust::evaluate_installed(root, directory, &manifest);
    let installed = root.join(&manifest.name).join("manifest.json");
    if installed.exists() {
        let old = discovery::read_and_validate_manifest(&installed)?;
        if trust::compare_versions(&manifest.version, &old.version) != std::cmp::Ordering::Greater {
            return Err(format!(
                "已安装 {}；重复导入、降级及同版本重新打包均被阻止，请作者提升版本",
                old.version
            ));
        }
        evaluation.upgrade_from = Some(old.version);
        evaluation.permissions_added = manifest
            .permissions
            .iter()
            .filter(|p| !old.permissions.contains(p))
            .cloned()
            .collect();
        evaluation.permissions_removed = old
            .permissions
            .iter()
            .filter(|p| !manifest.permissions.contains(p))
            .cloned()
            .collect();
        if old.publisher.as_ref().map(|p| (&p.id, &p.source))
            != manifest.publisher.as_ref().map(|p| (&p.id, &p.source))
        {
            evaluation
                .risks
                .push("安装包的发布者或来源与已安装版本不同，请核对来源".into());
        }
    }
    if let Some(reason) = &evaluation.blocked_reason {
        return Err(reason.clone());
    }
    if manifest.api_version.is_empty() {
        evaluation.risks.push("旧权限声明：API 按声明逐项授权；403 时请作者补全 server.info、reader.state.read、reader.command.send、sidebar.add、page.register 并提升版本重新签名".into());
    }
    let has_backend = manifest
        .entry
        .as_ref()
        .and_then(|e| e.backend.as_ref())
        .is_some();
    Ok(ExtensionInfo {
        name: manifest.name,
        version: manifest.version,
        display_name: manifest.display_name,
        description: manifest.description,
        author: manifest.author,
        enabled: false,
        resume_pending: false,
        port: 0,
        permissions: manifest.permissions,
        sidebar: manifest.sidebar.map(|s| super::SidebarInfo {
            label: s.label,
            icon: s.icon,
            order: s.order,
        }),
        has_backend,
        has_ui: manifest
            .entry
            .as_ref()
            .is_some_and(|e| e.ui_port > 0 || e.backend.is_some()),
        trust: evaluation,
    })
}
impl Installer {
    pub fn prepare(&mut self, root: &Path, source: &Path) -> Result<Preview, String> {
        if !matches!(std::env::consts::OS, "windows" | "macos" | "linux") {
            return Err("ZIP 扩展仅支持 Windows、macOS 和 Linux 桌面版".into());
        }
        self.pending = None; // Bound disk usage to one outstanding preview per app.
        recover(root)?;
        let staging = root.join(".staging");
        fs::create_dir_all(&staging).map_err(err)?;
        lifecycle::secure_extensions_directory(&staging)?;
        let directory = tempfile::tempdir_in(&staging).map_err(err)?;
        if source
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case("zip"))
        {
            return Err("请选择 .zip 扩展包".into());
        }
        // Snapshot the chosen file before any ZIP indexing. Normal writers or
        // downloads cannot swap the archive between metadata preflight and use.
        let mut input = File::open(source).map_err(err)?.take(MAX_ZIP + 1);
        let mut archive = tempfile::NamedTempFile::new_in(&staging).map_err(err)?;
        let copied = std::io::copy(&mut input, archive.as_file_mut()).map_err(err)?;
        if copied > MAX_ZIP {
            return Err("ZIP 超过 512 MiB，请缩小包内容".into());
        }
        archive.as_file_mut().rewind().map_err(err)?;
        extract(
            archive.reopen().map_err(err)?,
            directory.path(),
            MAX_FILE,
            MAX_TOTAL,
        )?;
        let info = evaluate(root, directory.path())?;
        let token = uuid::Uuid::new_v4().to_string();
        self.pending = Some(Pending {
            token: token.clone(),
            digest: info.trust.package_digest.clone(),
            signature: read_optional(&directory.path().join("signature.json"))?,
            installed: installed_digest(root, &info.name)?,
            directory,
            created: Instant::now(),
        });
        Ok(Preview {
            ticket: token,
            extension: info,
        })
    }
    pub fn cancel(&mut self, ticket: &str) {
        if self.pending.as_ref().is_some_and(|p| p.token == ticket) {
            self.pending = None;
        }
    }
    pub fn commit(
        &mut self,
        state: &ExtensionRuntime,
        ticket: &str,
        digest: &str,
    ) -> Result<(), String> {
        self.commit_inner(state, ticket, digest, || Ok(()))
    }
    fn commit_inner(
        &mut self,
        state: &ExtensionRuntime,
        ticket: &str,
        digest: &str,
        after_switch: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .take()
            .ok_or("导入已取消或过期，请重新选择 ZIP")?;
        if pending.token != ticket
            || pending.digest != digest
            || pending.created.elapsed() > Duration::from_secs(600)
        {
            return Err("导入确认已失效，请重新选择 ZIP".into());
        }
        let info = evaluate(&state.extensions_dir, pending.directory.path())?;
        if read_optional(&pending.directory.path().join("signature.json"))? != pending.signature
            || info.trust.package_digest != pending.digest
            || installed_digest(&state.extensions_dir, &info.name)? != pending.installed
        {
            return Err("确认期间包内容或已安装版本发生变化，请重新导入".into());
        }
        let manifest =
            discovery::read_and_validate_manifest(&pending.directory.path().join("manifest.json"))?;
        let root = &state.extensions_dir;
        let name = &manifest.name;
        let transaction = root.join(".transaction");
        fs::create_dir(&transaction).map_err(err)?;
        // Snapshot before mutation; incomplete journals never touch installed trees.
        let journal = Journal {
            name: name.clone(),
            had_old: root.join(name).exists(),
            trust: read_optional(&root.join("trust.json"))?,
            runtime: read_optional(&root.join("runtime.json"))?,
        };
        lifecycle::atomic_write(
            &transaction.join("journal.json"),
            &serde_json::to_vec(&journal).map_err(err)?,
        )?;
        let old = state.enabled.lock().unwrap().remove(name);
        let was_enabled = old.is_some();
        if let Some(old) = old {
            super::stop_extension_backend(old);
        }
        let result: Result<(), String> = (|| {
            if journal.had_old {
                fs::rename(root.join(name), transaction.join("old")).map_err(err)?;
                sync_directory(&transaction)?;
                sync_directory(root)?;
            }
            // Host storage is the only mutable root file copied into the new package.
            // All other legacy data remains intact in the archived old tree.
            let storage = transaction.join("old/storage.json");
            if storage.is_file() {
                fs::copy(&storage, pending.directory.path().join("storage.json")).map_err(err)?;
            }
            trust::authorize_activation(root, pending.directory.path(), &manifest, Some(digest))?;
            if let Some(backend) = manifest.entry.as_ref().and_then(|e| e.backend.as_ref()) {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        pending.directory.path().join(&backend.executable),
                        fs::Permissions::from_mode(0o700),
                    )
                    .map_err(err)?;
                }
            }
            fs::rename(pending.directory.path(), root.join(name)).map_err(err)?;
            sync_directory(root)?;
            after_switch()?;
            if was_enabled {
                super::activate(state, name, Some(digest))?;
            }
            // The commit marker is durable before the archive step. Recovery either
            // restores old state or retains the complete new directory, never mixes.
            lifecycle::atomic_write(&transaction.join("committed"), b"1")?;
            Ok(())
        })();
        if let Err(error) = result {
            if let Some(ext) = state.enabled.lock().unwrap().remove(name) {
                super::stop_extension_backend(ext);
            }
            recover(root).map_err(|e| {
                format!("安装失败: {error}；回滚失败: {e}。保留 .transaction，请重启后重试")
            })?;
            if was_enabled {
                if let Err(e) = super::activate(state, name, pending.installed.as_deref()) {
                    return Err(format!(
                        "安装失败: {error}；旧包与期望启用状态已恢复，旧后端需手动重试: {e}"
                    ));
                }
            }
            return Err(format!("安装失败，已恢复旧版本: {error}"));
        }
        recover(root)?;
        Ok(())
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
struct Journal {
    name: String,
    had_old: bool,
    trust: Option<Vec<u8>>,
    runtime: Option<Vec<u8>>,
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn restore_file(path: &Path, data: &Option<Vec<u8>>) -> Result<(), String> {
    if let Some(data) = data {
        lifecycle::atomic_write(path, data)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}
pub(super) fn recover(root: &Path) -> Result<(), String> {
    let transaction = root.join(".transaction");
    if !transaction.exists() {
        return Ok(());
    }
    if !transaction.join("journal.json").exists() {
        fs::remove_dir_all(transaction).map_err(err)?;
        return Ok(());
    }
    let journal: Journal =
        serde_json::from_slice(&fs::read(transaction.join("journal.json")).map_err(err)?)
            .map_err(err)?;
    discovery::validate_name(&journal.name)?;
    let target = root.join(&journal.name);
    let old = transaction.join("old");
    if !transaction.join("committed").exists() {
        if old.exists() || !journal.had_old {
            if target.exists() {
                fs::remove_dir_all(&target).map_err(err)?;
            }
            if old.exists() {
                fs::rename(&old, &target).map_err(err)?;
            }
        }
        restore_file(&root.join("trust.json"), &journal.trust)?;
        restore_file(&root.join("runtime.json"), &journal.runtime)?;
    } else if old.exists() {
        let archive = root.join(".previous").join(&journal.name);
        fs::create_dir_all(&archive).map_err(err)?;
        fs::rename(old, archive.join(uuid::Uuid::new_v4().to_string())).map_err(err)?;
    }
    fs::remove_dir_all(transaction).map_err(err)?;
    sync_directory(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    fn archive(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let mut file = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        {
            let mut writer = zip::ZipWriter::new(&mut file);
            for (name, data) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        file
    }
    fn runtime(root: &Path) -> ExtensionRuntime {
        ExtensionRuntime {
            operations: std::sync::Arc::new(std::sync::Mutex::new(())),
            installer: std::sync::Mutex::new(Installer::default()),
            recovery_error: None,
            _directory_lock: Some(lock_directory(root).unwrap()),
            enabled: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            next_port: std::sync::Arc::new(std::sync::atomic::AtomicU16::new(19557)),
            extensions_dir: root.to_owned(),
            api_port: 0,
            ws_port: 0,
            ws_broadcast: std::sync::mpsc::channel().0,
            pending_commands: std::sync::Arc::new(std::sync::Mutex::new(
                super::super::api_server::PendingCommands::default(),
            )),
            port_range_start: 19557,
        }
    }
    fn package(version: &str, permissions: &[&str]) -> tempfile::NamedTempFile {
        let manifest = serde_json::json!({"name":"sample", "version":version, "display_name":"Sample", "api_version":"1", "permissions":permissions}).to_string();
        archive(&[
            ("manifest.json", manifest.as_bytes()),
            ("ui/index.html", b"safe"),
        ])
    }
    #[test]
    fn cooperating_hosts_cannot_install_or_enable_the_same_root_concurrently() {
        let root = tempfile::tempdir().unwrap();
        let first = lock_directory(root.path()).unwrap();
        assert!(lock_directory(root.path()).is_err());
        drop(first);
        assert!(lock_directory(root.path()).is_ok());
    }

    #[test]
    fn imports_real_cli_zip_when_supplied() {
        let Ok(path) = std::env::var("MOKE_TEST_IMPORT_ZIP") else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let mut state = runtime(root.path());
        let ws_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        state.ws_port = ws_listener.local_addr().unwrap().port();
        let mut installer = Installer::default();
        let preview = installer.prepare(root.path(), Path::new(&path)).unwrap();
        assert_eq!(
            preview.extension.trust.signature_status,
            "unknown_publisher"
        );
        assert!(preview.extension.has_backend);
        installer
            .commit(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest,
            )
            .unwrap();
        assert!(state.enabled.lock().unwrap().is_empty());
        assert!(root.path().join("reading-stats/server.exe").is_file());
        // This phase is explicit activation, separate from import. Always reap
        // the exact test child before asserting success or returning.
        let activated = super::super::activate(
            &state,
            "reading-stats",
            Some(&preview.extension.trust.package_digest),
        );
        let ext = state.enabled.lock().unwrap().remove("reading-stats");
        let spawned = ext
            .as_ref()
            .is_some_and(|e| e.backend.lock().unwrap().is_some());
        if let Some(ext) = ext {
            super::super::stop_extension_backend(ext);
        }
        activated.unwrap();
        assert!(spawned);
    }

    #[test]
    fn install_cancel_permissions_upgrade_rollback_and_stale_ticket() {
        let root = tempfile::tempdir().unwrap();
        let state = runtime(root.path());
        let mut installer = Installer::default();
        let first = package("1.0.0", &["storage"]);
        let preview = installer.prepare(root.path(), first.path()).unwrap();
        installer.cancel(&preview.ticket);
        assert!(!root.path().join("sample").exists());
        assert!(installer
            .commit(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest
            )
            .is_err());
        let preview = installer.prepare(root.path(), first.path()).unwrap();
        installer
            .commit(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest,
            )
            .unwrap();
        assert!(state.enabled.lock().unwrap().is_empty()); // import never activates first install
        super::super::activate(
            &state,
            "sample",
            Some(&preview.extension.trust.package_digest),
        )
        .unwrap();
        fs::write(
            root.path().join("sample/storage.json"),
            br#"{"key":"keep"}"#,
        )
        .unwrap();
        assert!(installer.prepare(root.path(), first.path()).is_err());
        let second = package("2.0.0", &["storage", "server.info"]);
        let preview = installer.prepare(root.path(), second.path()).unwrap();
        assert_eq!(
            preview.extension.trust.permissions_added,
            vec!["server.info"]
        );
        let error = installer
            .commit_inner(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest,
                || Err("injected switch failure".into()),
            )
            .unwrap_err();
        assert!(error.contains("injected"));
        assert_eq!(
            discovery::read_and_validate_manifest(&root.path().join("sample/manifest.json"))
                .unwrap()
                .version,
            "1.0.0"
        );
        assert!(state.enabled.lock().unwrap().contains_key("sample"));
        let preview = installer.prepare(root.path(), second.path()).unwrap();
        installer
            .commit(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest,
            )
            .unwrap();
        assert_eq!(
            fs::read(root.path().join("sample/storage.json")).unwrap(),
            br#"{"key":"keep"}"#
        );
        assert!(state.enabled.lock().unwrap()["sample"]
            .permissions
            .contains(&"server.info".into()));
        assert!(installer.prepare(root.path(), first.path()).is_err());
        assert!(root.path().join(".previous/sample").exists());
    }
    #[test]
    fn changed_staging_is_not_authorized_by_an_old_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let state = runtime(root.path());
        let mut installer = Installer::default();
        let first = package("1.0.0", &[]);
        let preview = installer.prepare(root.path(), first.path()).unwrap();
        fs::write(
            installer
                .pending
                .as_ref()
                .unwrap()
                .directory
                .path()
                .join("ui/index.html"),
            b"changed",
        )
        .unwrap();
        assert!(installer
            .commit(
                &state,
                &preview.ticket,
                &preview.extension.trust.package_digest
            )
            .is_err());
        assert!(!root.path().join("sample").exists());
    }
    #[test]
    fn wrong_arch_and_scripts_rejected() {
        assert!(binary_targets(b"#!/bin/sh\n").is_empty());
        let mut elf = vec![0u8; 64];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[18] = 183;
        assert_eq!(binary_targets(&elf), vec!["linux-aarch64"]);
    }
    #[test]
    fn rejects_duplicate_symlink_and_inflated_directory_count_before_indexing() {
        for kind in ["duplicate", "symlink", "count"] {
            let zip = archive(&[("aa", b"a"), ("bb", b"b")]);
            let mut bytes = fs::read(zip.path()).unwrap();
            let central: Vec<_> = bytes
                .windows(4)
                .enumerate()
                .filter(|(_, b)| *b == b"PK\x01\x02")
                .map(|(i, _)| i)
                .collect();
            match kind {
                "duplicate" => {
                    let i = central[1] + 46;
                    bytes[i..i + 2].copy_from_slice(b"aa");
                }
                "symlink" => {
                    let i = central[0];
                    bytes[i + 5] = 3;
                    bytes[i + 38..i + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
                }
                _ => {
                    let i = bytes.len() - 22;
                    bytes[i + 8..i + 12].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
                }
            }
            fs::write(zip.path(), bytes).unwrap();
            let dir = tempfile::tempdir().unwrap();
            assert!(
                extract(zip.reopen().unwrap(), dir.path(), MAX_FILE, MAX_TOTAL).is_err(),
                "{kind}"
            );
            if kind == "count" || kind == "duplicate" {
                assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
            }
        }
    }

    #[test]
    fn extraction_rejects_traversal_collisions_and_reserved_state() {
        for path in [
            "../x",
            "/x",
            "C:/x",
            "a\\b",
            "a/../../x",
            "CON.txt",
            "a./x",
            "trust.json",
            "storage.json",
            "uninstall.exe",
        ] {
            let zip = archive(&[(path, b"bad")]);
            let dir = tempfile::tempdir().unwrap();
            assert!(
                extract(zip.reopen().unwrap(), dir.path(), MAX_FILE, MAX_TOTAL).is_err(),
                "{path}"
            );
        }
        let zip = archive(&[("a/x", b"a"), ("A/y", b"b")]);
        let dir = tempfile::tempdir().unwrap();
        assert!(extract(zip.reopen().unwrap(), dir.path(), MAX_FILE, MAX_TOTAL).is_err());
    }
    #[test]
    fn extraction_enforces_actual_limits_and_root() {
        for (file_limit, total_limit) in [(2, 100), (100, 2)] {
            let zip = archive(&[("manifest.json", b"abcd")]);
            let dir = tempfile::tempdir().unwrap();
            assert!(extract(zip.reopen().unwrap(), dir.path(), file_limit, total_limit).is_err());
        }
        let zip = archive(&[("manifest.json", b"{}"), ("ui/index.html", b"ok")]);
        let dir = tempfile::tempdir().unwrap();
        extract(zip.reopen().unwrap(), dir.path(), MAX_FILE, MAX_TOTAL).unwrap();
        assert_eq!(fs::read(dir.path().join("ui/index.html")).unwrap(), b"ok");
    }
    #[test]
    fn crash_recovery_restores_directory_and_state() {
        let root = tempfile::tempdir().unwrap();
        let tx = root.path().join(".transaction");
        fs::create_dir_all(tx.join("old")).unwrap();
        fs::write(tx.join("old/data"), b"keep").unwrap();
        fs::create_dir(root.path().join("sample")).unwrap();
        fs::write(root.path().join("trust.json"), b"new").unwrap();
        let journal = Journal {
            name: "sample".into(),
            had_old: true,
            trust: Some(b"old".to_vec()),
            runtime: None,
        };
        fs::write(
            tx.join("journal.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        recover(root.path()).unwrap();
        assert_eq!(fs::read(root.path().join("sample/data")).unwrap(), b"keep");
        assert_eq!(fs::read(root.path().join("trust.json")).unwrap(), b"old");
        assert!(!tx.exists());
    }
}
