//! Process-owned source reservations for the initial Linux Moke document.
//! This authorizes a source, not a remote user's identity. HTTP still belongs
//! to the controlled main document; a JS abort alone is not terminal IO proof.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Manager, State, Url, Webview};

const MAX_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS: usize = 64;
const ATTEMPT_DEADLINE: Duration = Duration::from_secs(15);
const BINDING_FILE: &str = "moke-native-source-bindings-v1.json";
const MAX_BINDING_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HOST_BINDINGS: usize = 4096;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionError {
    pub code: String,
    pub message: String,
}
fn failure(code: &str) -> ConnectionError {
    let message = match code {
        "unsupported" => "当前平台暂不支持原生列表连接。",
        "needs_restart" | "document_changed" | "unacked_commit" => {
            "连接状态无法安全恢复，请重启应用后从列表重新连接。"
        }
        "source_busy" => "仍有请求或连接操作未结束，请等待完成后重试。",
        "reader_in_use" => "本次应用已尝试打开阅读器，请重启应用后再切换连接。",
        "same_hostname_conflict" => "此配置不支持共享 Cookie 域边界的不同书库切换，请使用独立的干净配置或完成明确的来源迁移。",
        "entry_not_found" | "entry_changed" | "entry_unavailable" => {
            "已保存的服务器条目已改变，请返回列表重新选择。"
        }
        "registry_unavailable" => "无法核实服务器列表，请重新载入。",
        "source_provenance_unknown" => "已有认证数据的书库来源无法确认，请使用独立的干净配置或完成明确的来源迁移。",
        "source_provenance_tainted" => "阅读器或旧路径已使用共享认证数据，来源约束不再完整；请使用独立的干净配置或完成明确迁移。",
        "source_binding_unavailable" => "无法读取来源约束文件，原件已保留；请检查配置或使用独立的干净配置。",
        "source_binding_write_failed" => "无法可靠保存来源约束，本次请求未发出；请检查配置目录后重新启动。",
        _ => "连接凭据已失效，请返回列表重新选择。",
    };
    ConnectionError {
        code: code.into(),
        message: message.into(),
    }
}
fn opaque_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSource {
    pub id: String,
    pub entry_revision: String,
    pub base_url: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSource {
    #[serde(flatten)]
    pub source: NativeSource,
    pub session_token: String,
    pub epoch: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySnapshot {
    pub process_id: String,
    pub document_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_token: Option<String>,
    pub epoch: u64,
    pub phase: &'static str,
    pub pending_count: usize,
    pub active: Option<ActiveSource>,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptGrant {
    pub attempt_token: String,
    pub epoch: u64,
    pub source: NativeSource,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchGrant {
    pub request_id: String,
    pub epoch: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReceipt {
    pub attempt_token: String,
    pub session_token: String,
    pub epoch: u64,
    pub source: NativeSource,
}
#[derive(Clone)]
struct PendingRequest {
    document_token: String,
    lease_token: String,
    epoch: u64,
}

// Without a PSL/cookie-partition contract, DNS hosts sharing even one final
// label are conservatively one cookie boundary, including unrelated .com sites.
fn cookie_scope_key(host: &str) -> String {
    let ip_text = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = ip_text.parse::<std::net::IpAddr>() {
        return format!("ip:{ip}");
    }
    let hostname = host.trim_end_matches('.').to_ascii_lowercase();
    format!("dns:{}", hostname.rsplit('.').next().unwrap_or(&hostname))
}
fn scopes_conflict(known_host: &str, known_base: &str, host: &str, base: &str) -> bool {
    known_base != base && cookie_scope_key(known_host) == cookie_scope_key(host)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostBinding {
    hostname: String,
    base_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingRecords {
    version: u8,
    tainted: bool,
    bindings: Vec<HostBinding>,
}
impl Default for BindingRecords {
    fn default() -> Self {
        Self {
            version: 1,
            tainted: false,
            bindings: Vec::new(),
        }
    }
}
struct CookieBoundary {
    config: PathBuf,
    cache: PathBuf,
    raw: Option<String>,
    records: BindingRecords,
}
fn binding_read(path: &Path) -> Result<Option<String>, ConnectionError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("source_binding_unavailable")),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_BINDING_BYTES
    {
        return Err(failure("source_binding_unavailable"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| failure("source_binding_unavailable"))?
        .take(MAX_BINDING_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("source_binding_unavailable"))?;
    if bytes.len() as u64 > MAX_BINDING_BYTES {
        return Err(failure("source_binding_unavailable"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| failure("source_binding_unavailable"))
}
fn cookie_file_is_empty(cache: &Path) -> Result<bool, ConnectionError> {
    let path = cache.join(".cookies");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err(failure("source_provenance_unknown")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure("source_provenance_unknown"));
    }
    if metadata.len() == 0 {
        return Ok(true);
    }
    // The plugin writes an empty jar as exactly []. Never parse or retain an
    // existing nonempty jar, nor copy any cookie field into authority metadata.
    if metadata.len() > 4096 {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| failure("source_provenance_unknown"))?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("source_provenance_unknown"))?;
    Ok(bytes.iter().all(u8::is_ascii_whitespace)
        || std::str::from_utf8(&bytes).is_ok_and(|raw| raw.trim() == "[]"))
}
impl CookieBoundary {
    fn load_records(config: PathBuf, cache: PathBuf) -> Result<Self, ConnectionError> {
        let directory = config.join("server-registry");
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(failure("source_binding_unavailable"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(failure("source_binding_unavailable")),
        }
        let raw = binding_read(&directory.join(BINDING_FILE))?;
        let records: BindingRecords = match &raw {
            Some(raw) => {
                serde_json::from_str(raw).map_err(|_| failure("source_binding_unavailable"))?
            }
            None => BindingRecords::default(),
        };
        if records.version != 1 || records.bindings.len() > MAX_HOST_BINDINGS {
            return Err(failure("source_binding_unavailable"));
        }
        let mut hosts = BTreeSet::new();
        for binding in &records.bindings {
            let base = canonical_base(&binding.base_url)
                .map_err(|_| failure("source_binding_unavailable"))?;
            if base.host_str() != Some(binding.hostname.as_str())
                || !hosts.insert(binding.hostname.clone())
            {
                return Err(failure("source_binding_unavailable"));
            }
        }
        Ok(Self {
            config,
            cache,
            raw,
            records,
        })
    }
    fn load(config: PathBuf, cache: PathBuf) -> Result<Self, ConnectionError> {
        let boundary = Self::load_records(config, cache)?;
        if !boundary.records.tainted
            && (boundary.raw.is_none() || boundary.records.bindings.is_empty())
            && !cookie_file_is_empty(&boundary.cache)?
        {
            return Err(failure("source_provenance_unknown"));
        }
        if !boundary.records.tainted {
            let mut scopes = BTreeMap::new();
            for binding in &boundary.records.bindings {
                let scope = cookie_scope_key(&binding.hostname);
                if scopes
                    .insert(scope, &binding.base_url)
                    .is_some_and(|base| base != &binding.base_url)
                {
                    return Err(failure("source_provenance_unknown"));
                }
            }
        }
        Ok(boundary)
    }
    fn bindings(&self) -> BTreeMap<String, String> {
        self.records
            .bindings
            .iter()
            .map(|binding| (binding.hostname.clone(), binding.base_url.clone()))
            .collect()
    }
    fn verify(&self) -> Result<(), ConnectionError> {
        match fs::symlink_metadata(self.config.join("server-registry")) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(failure("source_binding_unavailable"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && self.raw.is_none() => {}
            Err(_) => return Err(failure("source_binding_unavailable")),
        }

        if binding_read(&self.config.join("server-registry").join(BINDING_FILE))? != self.raw {
            return Err(failure("source_binding_unavailable"));
        }
        Ok(())
    }
    fn persist(&mut self, records: BindingRecords) -> Result<(), ConnectionError> {
        if records.bindings.len() > MAX_HOST_BINDINGS {
            return Err(failure("source_binding_write_failed"));
        }
        let encoded =
            serde_json::to_string(&records).map_err(|_| failure("source_binding_write_failed"))?;
        if encoded.len() as u64 > MAX_BINDING_BYTES {
            return Err(failure("source_binding_write_failed"));
        }
        self.verify()
            .map_err(|_| failure("source_binding_write_failed"))?;
        let directory = self.config.join("server-registry");
        fs::create_dir_all(&directory).map_err(|_| failure("source_binding_write_failed"))?;
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| failure("source_binding_write_failed"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(failure("source_binding_write_failed"));
        }
        let path = directory.join(BINDING_FILE);
        let temporary = directory.join(format!("{BINDING_FILE}.{}.tmp", opaque_token()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| failure("source_binding_write_failed"))?;
        let result = (|| {
            file.write_all(encoded.as_bytes())
                .map_err(|_| failure("source_binding_write_failed"))?;
            file.sync_all()
                .map_err(|_| failure("source_binding_write_failed"))?;
            drop(file);
            self.verify()
                .map_err(|_| failure("source_binding_write_failed"))?;
            fs::rename(&temporary, &path).map_err(|_| failure("source_binding_write_failed"))?;
            #[cfg(unix)]
            fs::File::open(&directory)
                .and_then(|file| file.sync_all())
                .map_err(|_| failure("source_binding_write_failed"))?;
            if binding_read(&path)
                .map_err(|_| failure("source_binding_write_failed"))?
                .as_deref()
                != Some(encoded.as_str())
            {
                return Err(failure("source_binding_write_failed"));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        self.raw = Some(encoded);
        self.records = records;
        Ok(())
    }
    fn bind(&mut self, host: &str, base: &str) -> Result<(), ConnectionError> {
        if self.records.tainted {
            return Err(failure("source_provenance_tainted"));
        }
        if self
            .records
            .bindings
            .iter()
            .any(|binding| scopes_conflict(&binding.hostname, &binding.base_url, host, base))
        {
            return Err(failure("same_hostname_conflict"));
        }
        if let Some(existing) = self
            .records
            .bindings
            .iter()
            .find(|binding| binding.hostname == host)
        {
            if existing.base_url != base {
                return Err(failure("same_hostname_conflict"));
            }
            return self.verify();
        }
        let mut records = self.records.clone();
        records.bindings.push(HostBinding {
            hostname: host.into(),
            base_url: base.into(),
        });
        records.bindings.sort_by(|a, b| a.hostname.cmp(&b.hostname));
        self.persist(records)
    }
    fn taint(&mut self) -> Result<(), ConnectionError> {
        if self.records.tainted {
            return self.verify();
        }
        let mut records = self.records.clone();
        records.tainted = true;
        self.persist(records)
    }
}

struct Authority {
    process_id: String,
    document_generation: u64,
    document_seen: bool,
    document_token: Option<String>,
    document_revoked: bool,
    epoch: u64,
    active: Option<ActiveSource>,
    attempt: Option<AttemptGrant>,
    attempt_deadline: Option<Instant>,
    unacked: Option<SessionReceipt>,
    pending: BTreeMap<String, PendingRequest>,
    used_hostnames: BTreeMap<String, String>,
    restart_reason: Option<String>,
    cookie_boundary: Option<CookieBoundary>,
    cookie_paths: Option<(PathBuf, PathBuf)>,
    cookie_error: Option<String>,
    reader_tainted: bool,
}
impl Default for Authority {
    fn default() -> Self {
        Self {
            process_id: opaque_token(),
            document_generation: 0,
            document_seen: false,
            document_token: None,
            document_revoked: false,
            epoch: 0,
            active: None,
            attempt: None,
            attempt_deadline: None,
            unacked: None,
            pending: BTreeMap::new(),
            used_hostnames: BTreeMap::new(),
            restart_reason: None,
            cookie_boundary: None,
            cookie_paths: None,
            cookie_error: None,
            reader_tainted: false,
        }
    }
}
impl Authority {
    fn snapshot(&self, include_document: bool) -> AuthoritySnapshot {
        AuthoritySnapshot {
            process_id: self.process_id.clone(),
            document_generation: self.document_generation,
            document_token: if include_document {
                self.document_token.clone()
            } else {
                None
            },
            epoch: self.epoch,
            phase: if self.restart_reason.is_some() || self.cookie_error.is_some() {
                "needs_restart"
            } else if self.unacked.is_some() {
                "unacked"
            } else if self.attempt.is_some() {
                "attempt"
            } else if self.active.is_some() {
                "active"
            } else {
                "idle"
            },
            pending_count: self.pending.len(),
            active: self.active.clone(),
            reason: self
                .cookie_error
                .clone()
                .or_else(|| self.restart_reason.clone()),
        }
    }
    fn restart(&mut self, reason: &str) {
        self.restart_reason.get_or_insert_with(|| reason.into());
        self.attempt = None;
        self.attempt_deadline = None;
    }
    fn document_started(&mut self) {
        if self.document_seen && self.document_token.is_some() {
            self.document_revoked = true;
            self.restart("document_changed");
        }
        self.document_seen = true;
        match self.document_generation.checked_add(1) {
            Some(generation) => self.document_generation = generation,
            None => self.restart("generation_exhausted"),
        }
    }
    fn document_navigation(&mut self) {
        if self.document_token.is_some() {
            self.document_revoked = true;
            self.restart("document_changed");
        }
    }
    fn claim_document(&mut self) -> Result<AuthoritySnapshot, ConnectionError> {
        if self.document_token.is_some() {
            self.document_revoked = true;
            self.restart("document_reinitialized");
            return Err(failure("needs_restart"));
        }
        if let Some(code) = &self.cookie_error {
            return Err(failure(code));
        }
        if self.restart_reason.is_some() {
            return Err(failure("needs_restart"));
        }
        if !self.document_seen {
            return Err(failure("document_unavailable"));
        }
        self.document_token = Some(opaque_token());
        Ok(self.snapshot(true))
    }
    fn document(&self, token: &str) -> Result<(), ConnectionError> {
        if self.document_revoked {
            return Err(failure("document_changed"));
        }
        if self.document_token.as_deref() != Some(token) {
            return Err(failure("invalid_document"));
        }
        Ok(())
    }
    fn live(&self, token: &str, expected_epoch: u64) -> Result<(), ConnectionError> {
        self.document(token)?;
        if let Some(code) = &self.cookie_error {
            return Err(failure(code));
        }
        if self.restart_reason.is_some() {
            return Err(failure("needs_restart"));
        }
        if self.epoch != expected_epoch {
            return Err(failure("epoch_changed"));
        }
        Ok(())
    }
    fn same_host_guard(&self, source: &NativeSource) -> Result<(), ConnectionError> {
        let host = canonical_base(&source.base_url)?
            .host_str()
            .ok_or_else(|| failure("invalid_source"))?
            .to_owned();
        if self
            .used_hostnames
            .iter()
            .any(|(known_host, base)| scopes_conflict(known_host, base, &host, &source.base_url))
        {
            return Err(failure("same_hostname_conflict"));
        }
        if let Some(active) = &self.active {
            let active_base = canonical_base(&active.source.base_url)?;
            if active_base.host_str().is_some_and(|active_host| {
                scopes_conflict(
                    active_host,
                    &active.source.base_url,
                    &host,
                    &source.base_url,
                )
            }) {
                return Err(failure("same_hostname_conflict"));
            }
        }
        Ok(())
    }
    fn begin(
        &mut self,
        doc: &str,
        epoch: u64,
        source: NativeSource,
    ) -> Result<AttemptGrant, ConnectionError> {
        self.live(doc, epoch)?;
        if self.unacked.is_some() {
            return Err(failure("unacked_commit"));
        }
        if self.attempt.is_some() || !self.pending.is_empty() {
            return Err(failure("source_busy"));
        }
        self.same_host_guard(&source)?;
        let grant = AttemptGrant {
            attempt_token: opaque_token(),
            epoch: self.epoch,
            source,
        };
        self.attempt = Some(grant.clone());
        self.attempt_deadline = Some(Instant::now() + ATTEMPT_DEADLINE);
        Ok(grant)
    }
    fn selected_attempt(
        &self,
        doc: &str,
        token: &str,
        epoch: u64,
    ) -> Result<AttemptGrant, ConnectionError> {
        self.live(doc, epoch)?;
        if self.unacked.is_some() {
            return Err(failure("unacked_commit"));
        }
        let attempt = self
            .attempt
            .as_ref()
            .filter(|attempt| attempt.attempt_token == token && attempt.epoch == epoch)
            .cloned()
            .ok_or_else(|| failure("invalid_attempt"))?;
        if self
            .attempt_deadline
            .map_or(true, |deadline| Instant::now() >= deadline)
        {
            return Err(failure("attempt_expired"));
        }
        Ok(attempt)
    }
    fn lease_source(
        &self,
        doc: &str,
        token: &str,
        epoch: u64,
    ) -> Result<NativeSource, ConnectionError> {
        self.live(doc, epoch)?;
        if self.unacked.is_some() {
            return Err(failure("unacked_commit"));
        }
        if let Some(attempt) = &self.attempt {
            if attempt.attempt_token != token {
                return Err(failure("source_busy"));
            }
            return self
                .selected_attempt(doc, token, epoch)
                .map(|attempt| attempt.source);
        }
        self.active
            .as_ref()
            .filter(|active| active.session_token == token && active.epoch == epoch)
            .map(|active| active.source.clone())
            .ok_or_else(|| failure("invalid_lease"))
    }
    fn dispatch(
        &mut self,
        doc: &str,
        token: &str,
        epoch: u64,
        url: &str,
        method: &str,
        current: &NativeSource,
    ) -> Result<DispatchGrant, ConnectionError> {
        let source = self.lease_source(doc, token, epoch)?;
        same_source(&source, current)?;
        if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&method) {
            return Err(failure("invalid_method"));
        }
        validate_request_url(&source.base_url, url)?;
        // An unconfirmed earlier operation may still change the shared jar.
        // Do not mint a second mutation permit, even for the same source.
        // The legacy sign-out contract mutates the session through GET.
        // Read-only provider requests may continue in parallel.
        let legacy_sign_out = Url::parse(url)
            .map_err(|_| failure("invalid_request_url"))?
            .path()
            .trim_end_matches('/')
            .ends_with("/api/user/sign_out");
        if (legacy_sign_out || !["GET", "HEAD"].contains(&method)) && !self.pending.is_empty() {
            return Err(failure("source_busy"));
        }
        self.same_host_guard(&source)?;
        if self.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(failure("source_busy"));
        }
        let host = canonical_base(&source.base_url)?
            .host_str()
            .ok_or_else(|| failure("invalid_source"))?
            .to_owned();
        // A request can change cookies even if it later fails or is cancelled.
        // Reserve the hostname before the frontend receives permission to send.
        if let Some(boundary) = &mut self.cookie_boundary {
            if let Err(error) = boundary.bind(&host, &source.base_url) {
                self.cookie_error = Some(error.code.clone());
                return Err(error);
            }
        }
        self.used_hostnames.insert(host, source.base_url.clone());
        let request_id = opaque_token();
        self.pending.insert(
            request_id.clone(),
            PendingRequest {
                document_token: doc.into(),
                lease_token: token.into(),
                epoch,
            },
        );
        Ok(DispatchGrant { request_id, epoch })
    }
    fn settle(
        &mut self,
        doc: &str,
        token: &str,
        request_id: &str,
        epoch: u64,
    ) -> Result<(), ConnectionError> {
        // Cancellation retires the attempt, never the dispatch records. A
        // same-document late terminal response may settle only its own record.
        self.document(doc)?;
        let request = self
            .pending
            .get(request_id)
            .ok_or_else(|| failure("invalid_request"))?;
        if request.document_token != doc || request.lease_token != token || request.epoch != epoch {
            return Err(failure("invalid_request"));
        }
        self.pending.remove(request_id);
        Ok(())
    }
    fn commit(
        &mut self,
        doc: &str,
        token: &str,
        epoch: u64,
        current: &NativeSource,
    ) -> Result<SessionReceipt, ConnectionError> {
        let attempt = self.selected_attempt(doc, token, epoch)?;
        if !self.pending.is_empty() {
            return Err(failure("source_busy"));
        }
        same_source(&attempt.source, current)?;
        self.same_host_guard(current)?;
        let Some(next_epoch) = self.epoch.checked_add(1) else {
            self.restart("generation_exhausted");
            return Err(failure("needs_restart"));
        };
        self.epoch = next_epoch;
        let receipt = SessionReceipt {
            attempt_token: token.into(),
            session_token: opaque_token(),
            epoch: next_epoch,
            source: current.clone(),
        };
        self.active = Some(ActiveSource {
            source: current.clone(),
            session_token: receipt.session_token.clone(),
            epoch: next_epoch,
        });
        self.unacked = Some(receipt.clone());
        Ok(receipt)
    }
    fn ack(
        &mut self,
        doc: &str,
        token: &str,
        session_token: &str,
        epoch: u64,
        current: &NativeSource,
    ) -> Result<SessionReceipt, ConnectionError> {
        self.live(doc, epoch)?;
        let receipt = self
            .unacked
            .as_ref()
            .filter(|receipt| {
                receipt.attempt_token == token
                    && receipt.session_token == session_token
                    && receipt.epoch == epoch
            })
            .cloned()
            .ok_or_else(|| failure("invalid_attempt"))?;
        if same_source(&receipt.source, current).is_err() {
            self.restart("entry_changed_after_commit");
            return Err(failure("needs_restart"));
        }
        if !self.pending.is_empty() {
            self.restart("pending_after_commit");
            return Err(failure("needs_restart"));
        }
        self.unacked = None;
        self.attempt = None;
        self.attempt_deadline = None;
        Ok(receipt)
    }
    fn cancel(&mut self, doc: &str, token: &str) -> Result<(), ConnectionError> {
        self.document(doc)?;
        if self
            .unacked
            .as_ref()
            .is_some_and(|receipt| receipt.attempt_token == token)
        {
            self.restart("commit_not_acknowledged");
            return Err(failure("needs_restart"));
        }
        if self
            .attempt
            .as_ref()
            .is_some_and(|attempt| attempt.attempt_token == token)
        {
            self.attempt = None;
            self.attempt_deadline = None;
        }
        Ok(())
    }
    fn revoke_active(&mut self, doc: &str, token: &str) -> Result<(), ConnectionError> {
        self.document(doc)?;
        // An explicit disconnect cannot prove that a committed projection was
        // acknowledged. Preserve that uncertainty instead of reopening begin.
        if self.unacked.is_some() {
            self.restart("commit_not_acknowledged");
            return Err(failure("needs_restart"));
        }
        if !self
            .active
            .as_ref()
            .is_some_and(|active| active.session_token == token)
        {
            return Err(failure("invalid_session"));
        }
        // Revoke before returning even if the epoch is exhausted. Pending IO
        // belongs to its original ticket and is never evidence of completion.
        self.active = None;
        self.attempt = None;
        self.attempt_deadline = None;
        let Some(next_epoch) = self.epoch.checked_add(1) else {
            self.restart("generation_exhausted");
            return Err(failure("needs_restart"));
        };
        self.epoch = next_epoch;
        Ok(())
    }
}

#[derive(Default)]
pub struct ConnectionAuthority {
    inner: Mutex<Authority>,
}
impl ConnectionAuthority {
    fn lock(&self) -> Result<MutexGuard<'_, Authority>, ConnectionError> {
        self.inner.lock().map_err(|_| failure("needs_restart"))
    }
    pub fn main_document_started(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state.document_started();
    }
    pub fn main_navigation_started(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state.document_navigation();
    }
    pub fn main_document_destroyed(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state.document_revoked = true;
        state.restart("document_destroyed");
    }
    pub fn initialize_paths(&self, config: PathBuf, cache: PathBuf) -> Result<(), ConnectionError> {
        if !cfg!(all(target_os = "linux", not(target_env = "ohos"))) {
            return Ok(());
        }
        let mut state = self.lock()?;
        if state
            .cookie_paths
            .as_ref()
            .is_some_and(|paths| paths != &(config.clone(), cache.clone()))
        {
            state.cookie_error = Some("source_provenance_unknown".into());
            return Err(failure("source_provenance_unknown"));
        }
        state.cookie_paths = Some((config.clone(), cache.clone()));
        if state.cookie_boundary.is_some() {
            return match &state.cookie_error {
                Some(code) => Err(failure(code)),
                None => Ok(()),
            };
        }
        let loaded = if state.reader_tainted {
            CookieBoundary::load_records(config, cache)
        } else {
            CookieBoundary::load(config, cache)
        };
        match loaded {
            Ok(mut boundary) => {
                if state.reader_tainted {
                    if let Err(error) = boundary.taint() {
                        state.cookie_error = Some(error.code.clone());
                        return Err(error);
                    }
                }
                state.used_hostnames = boundary.bindings();
                let tainted = boundary.records.tainted;
                state.cookie_boundary = Some(boundary);
                if tainted {
                    state.cookie_error = Some("source_provenance_tainted".into());
                    return Err(failure("source_provenance_tainted"));
                }
                state.cookie_error = None;
                Ok(())
            }
            Err(error) => {
                state.cookie_error = Some(error.code.clone());
                Err(error)
            }
        }
    }
    pub fn mark_reader_attempt(&self) -> Result<(), ConnectionError> {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state.reader_tainted = true;
        state.restart("reader_in_use");
        if !cfg!(all(target_os = "linux", not(target_env = "ohos"))) {
            return Ok(());
        }
        if state.cookie_boundary.is_none() {
            let (config, cache) = state
                .cookie_paths
                .clone()
                .ok_or_else(|| failure("source_binding_unavailable"))?;
            // A deliberately tainted record does not claim to reconstruct an
            // old jar. It preserves the unknown provenance across restart.
            match CookieBoundary::load_records(config, cache) {
                Ok(boundary) => state.cookie_boundary = Some(boundary),
                Err(error) => {
                    state.cookie_error = Some(error.code.clone());
                    return Err(error);
                }
            }
        }
        if let Some(boundary) = &mut state.cookie_boundary {
            if let Err(error) = boundary.taint() {
                state.cookie_error = Some(error.code.clone());
                return Err(error);
            }
        }
        state.cookie_error = Some("source_provenance_tainted".into());
        Ok(())
    }
}

fn canonical_base(raw: &str) -> Result<Url, ConnectionError> {
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "%\\@?#".contains(c))
    {
        return Err(failure("invalid_source"));
    }
    let url = Url::parse(raw).map_err(|_| failure("invalid_source"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("invalid_source"));
    }
    let host = url.host_str().ok_or_else(|| failure("invalid_source"))?;
    if !host.contains(':') {
        let host = host.strip_suffix('.').unwrap_or(host);
        if host.len() > 253
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(failure("invalid_source"));
        }
    }
    let path = url.path().strip_prefix('/').unwrap_or(url.path());
    if !path.is_empty()
        && path.split('/').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return Err(failure("invalid_source"));
    }
    if url.as_str().strip_suffix('/').unwrap_or(url.as_str()) != raw {
        return Err(failure("invalid_source"));
    }
    Ok(url)
}
fn same_source(expected: &NativeSource, current: &NativeSource) -> Result<(), ConnectionError> {
    if expected == current {
        Ok(())
    } else {
        Err(failure("entry_changed"))
    }
}
fn validate_request_url(base: &str, requested: &str) -> Result<(), ConnectionError> {
    let base = canonical_base(base)?;
    let requested = Url::parse(requested).map_err(|_| failure("invalid_request_url"))?;
    if !requested.username().is_empty()
        || requested.password().is_some()
        || requested.fragment().is_some()
        || requested.origin() != base.origin()
    {
        return Err(failure("invalid_request_url"));
    }
    let prefix = base.path().trim_end_matches('/');
    if !prefix.is_empty()
        && requested.path() != prefix
        && !requested.path().starts_with(&format!("{prefix}/"))
    {
        return Err(failure("invalid_request_url"));
    }
    Ok(())
}
fn read_ready_source(
    config: &Path,
    id: &str,
    revision: &str,
) -> Result<NativeSource, ConnectionError> {
    let directory = config.join("server-registry");
    let path = directory.join("moke-saved-servers-v2.json");
    let directory_metadata =
        fs::symlink_metadata(&directory).map_err(|_| failure("registry_unavailable"))?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| failure("registry_unavailable"))?;
    if directory_metadata.file_type().is_symlink()
        || !directory_metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_REGISTRY_BYTES
    {
        return Err(failure("registry_unavailable"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|_| failure("registry_unavailable"))?
        .take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("registry_unavailable"))?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(failure("registry_unavailable"));
    }
    let registry: Value =
        serde_json::from_slice(&bytes).map_err(|_| failure("registry_unavailable"))?;
    if registry.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(failure("registry_unavailable"));
    }
    let entries = registry
        .get("savedServers")
        .and_then(Value::as_array)
        .ok_or_else(|| failure("registry_unavailable"))?;
    let mut ids = BTreeSet::new();
    for entry in entries {
        if !entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && ids.insert(id))
        {
            return Err(failure("registry_unavailable"));
        }
    }
    let entry = entries
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| failure("entry_not_found"))?;
    if entry.get("entryRevision").and_then(Value::as_str) != Some(revision) {
        return Err(failure("entry_changed"));
    }
    if entry.get("status").and_then(Value::as_str) != Some("ready") || entry.get("issue").is_some()
    {
        return Err(failure("entry_unavailable"));
    }
    let base = entry
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("invalid_source"))?;
    canonical_base(base)?;
    if entries
        .iter()
        .filter(|entry| entry.get("url").and_then(Value::as_str) == Some(base))
        .count()
        != 1
    {
        return Err(failure("entry_unavailable"));
    }
    Ok(NativeSource {
        id: id.into(),
        entry_revision: revision.into(),
        base_url: base.into(),
    })
}
fn owner(webview: &Webview) -> Result<(), ConnectionError> {
    if !cfg!(all(target_os = "linux", not(target_env = "ohos"))) {
        return Err(failure("unsupported"));
    }
    owner_shell(webview)
}
fn owner_shell(webview: &Webview) -> Result<(), ConnectionError> {
    if webview.label() != "main" || super::require_moke_shell(webview).is_err() {
        return Err(failure("forbidden"));
    }
    let current = webview.url().map_err(|_| failure("forbidden"))?;
    if !current.username().is_empty() || current.password().is_some() {
        return Err(failure("forbidden"));
    }
    let production = (current.scheme() == "tauri" && current.host_str() == Some("localhost"))
        || (current.scheme() == "http"
            && current.host_str() == Some("tauri.localhost")
            && current.port_or_known_default() == Some(80));
    let development = cfg!(debug_assertions)
        && webview
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| current.origin() == dev.origin());
    if !production && !development {
        return Err(failure("forbidden"));
    }
    Ok(())
}
fn config_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ConnectionError> {
    app.path()
        .app_config_dir()
        .map_err(|_| failure("registry_unavailable"))
}

#[tauri::command]
pub async fn moke_connection_document(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
) -> Result<AuthoritySnapshot, ConnectionError> {
    owner(&webview)?;
    state.initialize_paths(
        config_directory(&app)?,
        app.path()
            .app_cache_dir()
            .map_err(|_| failure("source_binding_unavailable"))?,
    )?;
    state.lock()?.claim_document()
}
#[tauri::command]
pub async fn moke_connection_status(
    webview: Webview,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
) -> Result<AuthoritySnapshot, ConnectionError> {
    owner(&webview)?;
    let state = state.lock()?;
    state.document(&document_token)?;
    Ok(state.snapshot(false))
}
#[tauri::command]
pub async fn moke_connection_begin(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    expected_epoch: u64,
    id: String,
    entry_revision: String,
) -> Result<AttemptGrant, ConnectionError> {
    owner(&webview)?;
    let mut state = state.lock()?;
    state.live(&document_token, expected_epoch)?;
    let source = read_ready_source(&config_directory(&app)?, &id, &entry_revision)?;
    state.begin(&document_token, expected_epoch, source)
}
#[tauri::command]
pub async fn moke_connection_check(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    attempt_token: String,
    expected_epoch: u64,
) -> Result<AttemptGrant, ConnectionError> {
    owner(&webview)?;
    let state = state.lock()?;
    let attempt = state.selected_attempt(&document_token, &attempt_token, expected_epoch)?;
    same_source(
        &attempt.source,
        &read_ready_source(
            &config_directory(&app)?,
            &attempt.source.id,
            &attempt.source.entry_revision,
        )?,
    )?;
    Ok(attempt)
}
#[tauri::command]
pub async fn moke_connection_dispatch(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    lease_token: String,
    expected_epoch: u64,
    url: String,
    method: String,
) -> Result<DispatchGrant, ConnectionError> {
    owner(&webview)?;
    let mut state = state.lock()?;
    let source = state.lease_source(&document_token, &lease_token, expected_epoch)?;
    let current = read_ready_source(&config_directory(&app)?, &source.id, &source.entry_revision)?;
    state.dispatch(
        &document_token,
        &lease_token,
        expected_epoch,
        &url,
        &method,
        &current,
    )
}
#[tauri::command]
pub async fn moke_connection_settle(
    webview: Webview,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    lease_token: String,
    request_id: String,
    expected_epoch: u64,
) -> Result<(), ConnectionError> {
    owner(&webview)?;
    state
        .lock()?
        .settle(&document_token, &lease_token, &request_id, expected_epoch)
}
#[tauri::command]
pub async fn moke_connection_commit(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    attempt_token: String,
    expected_epoch: u64,
) -> Result<SessionReceipt, ConnectionError> {
    owner(&webview)?;
    let mut state = state.lock()?;
    let attempt = state.selected_attempt(&document_token, &attempt_token, expected_epoch)?;
    let current = read_ready_source(
        &config_directory(&app)?,
        &attempt.source.id,
        &attempt.source.entry_revision,
    )?;
    state.commit(&document_token, &attempt_token, expected_epoch, &current)
}
#[tauri::command]
pub async fn moke_connection_ack(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    attempt_token: String,
    session_token: String,
    expected_epoch: u64,
) -> Result<SessionReceipt, ConnectionError> {
    owner(&webview)?;
    let mut state = state.lock()?;
    state.live(&document_token, expected_epoch)?;
    let source = state
        .unacked
        .as_ref()
        .filter(|receipt| {
            receipt.attempt_token == attempt_token && receipt.session_token == session_token
        })
        .map(|receipt| receipt.source.clone())
        .ok_or_else(|| failure("invalid_attempt"))?;
    let current =
        match read_ready_source(&config_directory(&app)?, &source.id, &source.entry_revision) {
            Ok(source) => source,
            Err(_) => {
                state.restart("entry_changed_after_commit");
                return Err(failure("needs_restart"));
            }
        };
    state.ack(
        &document_token,
        &attempt_token,
        &session_token,
        expected_epoch,
        &current,
    )
}
#[tauri::command]
pub async fn moke_connection_cancel(
    webview: Webview,
    state: State<'_, ConnectionAuthority>,
    document_token: String,
    attempt_token: Option<String>,
    session_token: Option<String>,
) -> Result<AuthoritySnapshot, ConnectionError> {
    owner(&webview)?;
    let mut state = state.lock()?;
    match (attempt_token, session_token) {
        (Some(token), None) => state.cancel(&document_token, &token)?,
        (None, Some(token)) => state.revoke_active(&document_token, &token)?,
        _ => return Err(failure("invalid_cancel")),
    }
    Ok(state.snapshot(false))
}
#[tauri::command]
pub async fn moke_connection_mark_reader(
    webview: Webview,
    app: tauri::AppHandle,
    state: State<'_, ConnectionAuthority>,
) -> Result<(), ConnectionError> {
    if webview.label() != "main" || super::require_moke_shell(&webview).is_err() {
        return Err(failure("forbidden"));
    }
    if cfg!(all(target_os = "linux", not(target_env = "ohos"))) {
        let config = config_directory(&app)?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| failure("source_binding_unavailable"))?;
        // Unknown old jars may still use legacy Reader after a reliable taint.
        // Do not turn a connection-only provenance guard into a Reader ban.
        let _ = state.initialize_paths(config, cache);
    }
    state.mark_reader_attempt()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(id: &str, base: &str) -> NativeSource {
        NativeSource {
            id: id.into(),
            entry_revision: format!("revision-{id}"),
            base_url: base.into(),
        }
    }
    fn initial() -> (Authority, String) {
        let mut state = Authority::default();
        state.document_started();
        let doc = state.claim_document().unwrap().document_token.unwrap();
        (state, doc)
    }
    fn request(state: &mut Authority, doc: &str, attempt: &AttemptGrant) -> DispatchGrant {
        state
            .dispatch(
                doc,
                &attempt.attempt_token,
                attempt.epoch,
                &format!("{}/api/welcome", attempt.source.base_url),
                "GET",
                &attempt.source,
            )
            .unwrap()
    }
    fn activate(state: &mut Authority, doc: &str, source: NativeSource) -> SessionReceipt {
        let attempt = state.begin(doc, state.epoch, source.clone()).unwrap();
        let receipt = state
            .commit(doc, &attempt.attempt_token, attempt.epoch, &source)
            .unwrap();
        state
            .ack(
                doc,
                &receipt.attempt_token,
                &receipt.session_token,
                receipt.epoch,
                &source,
            )
            .unwrap()
    }
    #[test]
    fn native_epochs_tokens_and_unacked_receipt_gate_activation() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example/team/books");
        let attempt = state.begin(&doc, 0, a.clone()).unwrap();
        assert_eq!(state.epoch, 0);
        assert!(state.active.is_none());
        assert_eq!(
            state
                .selected_attempt(&doc, "invented", 0)
                .unwrap_err()
                .code,
            "invalid_attempt"
        );
        let receipt = state.commit(&doc, &attempt.attempt_token, 0, &a).unwrap();
        assert_eq!(receipt.epoch, 1);
        assert_eq!(state.snapshot(false).phase, "unacked");
        assert_eq!(
            state
                .lease_source(&doc, &receipt.session_token, 1)
                .unwrap_err()
                .code,
            "unacked_commit"
        );
        assert!(state
            .ack(&doc, "wrong", &receipt.session_token, 1, &a)
            .is_err());
        state
            .ack(&doc, &attempt.attempt_token, &receipt.session_token, 1, &a)
            .unwrap();
        assert_eq!(
            state.lease_source(&doc, &receipt.session_token, 1).unwrap(),
            a
        );
        assert!(state.commit(&doc, &attempt.attempt_token, 0, &a).is_err());
        assert_eq!(state.snapshot(false).phase, "active");
    }
    #[test]
    fn cancelled_attempt_keeps_pending_and_same_document_late_settle_can_finish() {
        let (mut state, doc) = initial();
        let active = activate(&mut state, &doc, source("original", "https://old.original"));
        let a = source("a", "https://a.example/library");
        let attempt = state.begin(&doc, 1, a.clone()).unwrap();
        let pending = request(&mut state, &doc, &attempt);
        assert_eq!(
            state
                .commit(&doc, &attempt.attempt_token, 1, &a)
                .unwrap_err()
                .code,
            "source_busy"
        );
        state.cancel(&doc, &attempt.attempt_token).unwrap();
        assert_eq!(
            state.active.as_ref().unwrap().session_token,
            active.session_token
        );
        assert_eq!(
            state
                .begin(&doc, 1, source("b", "https://b.independent"))
                .unwrap_err()
                .code,
            "source_busy"
        );
        assert!(state.settle(&doc, "wrong", &pending.request_id, 1).is_err());
        assert_eq!(state.pending.len(), 1);
        state
            .settle(&doc, &attempt.attempt_token, &pending.request_id, 1)
            .unwrap();
        let b = state
            .begin(&doc, 1, source("b", "https://b.independent"))
            .unwrap();
        assert!(state
            .settle(&doc, &attempt.attempt_token, &pending.request_id, 1)
            .is_err());
        assert_eq!(
            state.attempt.as_ref().unwrap().attempt_token,
            b.attempt_token
        );
        assert!(state
            .selected_attempt(&doc, &attempt.attempt_token, 1)
            .is_err());
    }
    #[test]
    fn disconnect_revokes_native_session_but_retains_terminal_tickets_and_commit_uncertainty() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example/library");
        let receipt = activate(&mut state, &doc, a.clone());
        let pending = state
            .dispatch(
                &doc,
                &receipt.session_token,
                receipt.epoch,
                "https://a.example/library/api/welcome",
                "GET",
                &a,
            )
            .unwrap();
        assert_eq!(
            state.revoke_active(&doc, "invented").unwrap_err().code,
            "invalid_session"
        );
        assert!(state.active.is_some());
        state.revoke_active(&doc, &receipt.session_token).unwrap();
        assert_eq!(state.epoch, receipt.epoch + 1);
        assert_eq!(state.snapshot(false).phase, "idle");
        assert!(state.active.is_none());
        assert_eq!(state.pending.len(), 1);
        assert!(state
            .dispatch(
                &doc,
                &receipt.session_token,
                receipt.epoch,
                "https://a.example/library/api/welcome",
                "GET",
                &a,
            )
            .is_err());
        assert!(state
            .lease_source(&doc, &receipt.session_token, state.epoch)
            .is_err());
        assert_eq!(
            state.begin(&doc, state.epoch, a.clone()).unwrap_err().code,
            "source_busy"
        );
        state
            .settle(
                &doc,
                &receipt.session_token,
                &pending.request_id,
                receipt.epoch,
            )
            .unwrap();
        let next = state.begin(&doc, state.epoch, a.clone()).unwrap();
        let unacked = state
            .commit(&doc, &next.attempt_token, next.epoch, &a)
            .unwrap();
        assert_eq!(
            state
                .revoke_active(&doc, &unacked.session_token)
                .unwrap_err()
                .code,
            "needs_restart"
        );
        assert!(state.unacked.is_some());
        assert_eq!(state.snapshot(false).phase, "needs_restart");
        assert!(state
            .lease_source(&doc, &unacked.session_token, unacked.epoch)
            .is_err());

        let (mut state, doc) = initial();
        let receipt = activate(&mut state, &doc, a);
        state.epoch = u64::MAX;
        assert_eq!(
            state
                .revoke_active(&doc, &receipt.session_token)
                .unwrap_err()
                .code,
            "needs_restart"
        );
        assert!(state.active.is_none());
        assert_eq!(state.snapshot(false).phase, "needs_restart");
    }
    #[test]
    fn full_document_change_and_repeated_bootstrap_cannot_reauthorize_or_clear_io() {
        let (mut state, doc) = initial();
        let attempt = state
            .begin(&doc, 0, source("a", "http://a.example/prefix"))
            .unwrap();
        let pending = request(&mut state, &doc, &attempt);
        state.document_navigation();
        state.document_started();
        assert_eq!(state.snapshot(false).phase, "needs_restart");
        assert!(state.claim_document().is_err());
        assert_eq!(
            state
                .settle(&doc, &attempt.attempt_token, &pending.request_id, 0)
                .unwrap_err()
                .code,
            "document_changed"
        );
        assert_eq!(state.pending.len(), 1);
        let (mut other, other_doc) = initial();
        assert_ne!(state.process_id, other.process_id);
        assert!(other
            .begin(&doc, 0, source("a", "http://a.example"))
            .is_err());
        assert!(other.claim_document().is_err());
        assert!(other
            .begin(&other_doc, 0, source("a", "http://a.example"))
            .is_err());
    }
    #[test]
    fn reader_poison_commit_unknown_and_epoch_overflow_never_release_automatically() {
        let (mut state, doc) = initial();
        let a = source("a", "http://a.example");
        let attempt = state.begin(&doc, 0, a.clone()).unwrap();
        let receipt = state.commit(&doc, &attempt.attempt_token, 0, &a).unwrap();
        assert_eq!(
            state.cancel(&doc, &attempt.attempt_token).unwrap_err().code,
            "needs_restart"
        );
        assert!(state
            .ack(&doc, &attempt.attempt_token, &receipt.session_token, 1, &a)
            .is_err());
        let (mut state, doc) = initial();
        state.restart("reader_in_use");
        state.cancel(&doc, "old").unwrap();
        assert_eq!(
            state.begin(&doc, 0, a.clone()).unwrap_err().code,
            "needs_restart"
        );
        let (mut state, doc) = initial();
        state.epoch = u64::MAX;
        let attempt = state.begin(&doc, u64::MAX, a.clone()).unwrap();
        assert_eq!(
            state
                .commit(&doc, &attempt.attempt_token, u64::MAX, &a)
                .unwrap_err()
                .code,
            "needs_restart"
        );
    }
    #[test]
    fn dispatched_hostname_remains_bound_even_after_candidate_failure() {
        let (mut state, doc) = initial();
        let a = source("a", "https://books.example/team/a");
        let attempt = state.begin(&doc, 0, a).unwrap();
        let pending = request(&mut state, &doc, &attempt);
        state.cancel(&doc, &attempt.attempt_token).unwrap();
        state
            .settle(&doc, &attempt.attempt_token, &pending.request_id, 0)
            .unwrap();
        assert_eq!(
            state
                .begin(&doc, 0, source("b", "http://books.example:8080/team/b"))
                .unwrap_err()
                .code,
            "same_hostname_conflict"
        );
        assert!(state
            .begin(&doc, 0, source("b", "https://other.independent/team/b"))
            .is_ok());
    }
    #[test]
    fn dispatch_rechecks_source_method_full_prefix_and_active_pending() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example/team/books");
        let active = activate(&mut state, &doc, a.clone());
        for url in [
            "https://b.example/team/books/api",
            "https://a.example/team/books-other/api",
            "https://a.example/team/books/../outside",
            "https://user@a.example/team/books/api",
        ] {
            assert!(state
                .dispatch(&doc, &active.session_token, 1, url, "GET", &a)
                .is_err());
        }
        assert!(state
            .dispatch(
                &doc,
                &active.session_token,
                1,
                "https://a.example/team/books/api",
                "TRACE",
                &a
            )
            .is_err());
        assert!(state
            .dispatch(
                &doc,
                &active.session_token,
                1,
                "https://a.example/team/books/api",
                "GET",
                &source("a", "https://changed.example")
            )
            .is_err());
        let pending = state
            .dispatch(
                &doc,
                &active.session_token,
                1,
                "https://a.example/team/books/api?q=one",
                "GET",
                &a,
            )
            .unwrap();
        assert!(state
            .begin(&doc, 1, source("b", "https://b.independent"))
            .is_err());
        state
            .settle(&doc, &active.session_token, &pending.request_id, 1)
            .unwrap();
    }
    #[test]
    fn expired_attempt_cannot_check_dispatch_or_commit_but_retains_active_and_pending() {
        let (mut state, doc) = initial();
        let original = activate(&mut state, &doc, source("old", "https://old.original"));
        let a = source("a", "https://a.example/prefix");
        let attempt = state.begin(&doc, 1, a.clone()).unwrap();
        let pending = request(&mut state, &doc, &attempt);
        state.attempt_deadline = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(
            state
                .selected_attempt(&doc, &attempt.attempt_token, 1)
                .unwrap_err()
                .code,
            "attempt_expired"
        );
        assert_eq!(
            state
                .dispatch(
                    &doc,
                    &attempt.attempt_token,
                    1,
                    "https://a.example/prefix/api/welcome",
                    "GET",
                    &a
                )
                .unwrap_err()
                .code,
            "attempt_expired"
        );
        assert_eq!(
            state
                .commit(&doc, &attempt.attempt_token, 1, &a)
                .unwrap_err()
                .code,
            "attempt_expired"
        );
        assert_eq!(
            state.active.as_ref().unwrap().session_token,
            original.session_token
        );
        assert_eq!(state.pending.len(), 1);
        state.cancel(&doc, &attempt.attempt_token).unwrap();
        assert_eq!(state.pending.len(), 1);
        state
            .settle(&doc, &attempt.attempt_token, &pending.request_id, 1)
            .unwrap();
        assert!(state.begin(&doc, 1, a).is_ok());
    }
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("moke-connection-{}", opaque_token()));
        fs::create_dir_all(root.join("server-registry")).unwrap();
        root
    }
    fn registry(root: &Path, entries: Value) {
        fs::write(root.join("server-registry/moke-saved-servers-v2.json"), serde_json::json!({"version":2,"savedServers":entries,"legacySources":{"stateRaw":"immutable","urlRaw":null}}).to_string()).unwrap();
    }
    #[test]
    fn registry_is_fixed_authority_ready_revision_canonical_full_base_and_unique_id() {
        let root = fixture();
        let entry = serde_json::json!({"id":"saved-a","entryRevision":"revision-a","status":"ready","url":"https://public.example/team/books"});
        registry(&root, serde_json::json!([entry]));
        assert_eq!(
            read_ready_source(&root, "saved-a", "revision-a")
                .unwrap()
                .base_url,
            "https://public.example/team/books"
        );
        assert_eq!(
            read_ready_source(&root, "missing", "revision-a")
                .unwrap_err()
                .code,
            "entry_not_found"
        );
        assert_eq!(
            read_ready_source(&root, "saved-a", "old").unwrap_err().code,
            "entry_changed"
        );
        let mut changed = entry.clone();
        changed["status"] = "needs-edit".into();
        registry(&root, serde_json::json!([changed]));
        assert!(read_ready_source(&root, "saved-a", "revision-a").is_err());
        registry(&root, serde_json::json!([entry.clone(), entry]));
        assert_eq!(
            read_ready_source(&root, "saved-a", "revision-a")
                .unwrap_err()
                .code,
            "registry_unavailable"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn manual_public_long_base_is_not_subject_to_discovery_wire_policy() {
        let base = format!("https://xn--bcher-kva.example/{}", "long_".repeat(70));
        assert!(base.len() > 200);
        assert!(canonical_base(&base).is_ok());
        for invalid in [
            "https://a.example/one/../two",
            "https://a.example/prefix/",
            "https://a.example/%70refix",
            "https://a.example//prefix",
            "http://127.1",
            "http://a.example:0",
            "http://bad_host.example",
        ] {
            assert!(canonical_base(invalid).is_err(), "{invalid}");
        }
    }
    fn paths_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = fixture();
        let config = root.join("config");
        let cache = root.join("cache");
        fs::create_dir(&config).unwrap();
        fs::create_dir(&cache).unwrap();
        (root, config, cache)
    }
    fn configured_authority(config: &Path, cache: &Path) -> (ConnectionAuthority, String) {
        let authority = ConnectionAuthority::default();
        authority
            .initialize_paths(config.to_path_buf(), cache.to_path_buf())
            .unwrap();
        authority.main_document_started();
        let doc = authority
            .lock()
            .unwrap()
            .claim_document()
            .unwrap()
            .document_token
            .unwrap();
        (authority, doc)
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn durable_dispatch_binding_survives_cold_state_and_retains_same_hostname_guard() {
        let (root, config, cache) = paths_fixture();
        fs::write(cache.join(".cookies"), "[]").unwrap();
        let a = source("a", "https://books.example/team/a");
        let (authority, doc) = configured_authority(&config, &cache);
        {
            let mut state = authority.lock().unwrap();
            let attempt = state.begin(&doc, 0, a.clone()).unwrap();
            let pending = request(&mut state, &doc, &attempt);
            assert!(config.join("server-registry").join(BINDING_FILE).is_file());
            state
                .settle(&doc, &attempt.attempt_token, &pending.request_id, 0)
                .unwrap();
            state.cancel(&doc, &attempt.attempt_token).unwrap();
        }
        drop(authority);
        // A dummy nonempty jar models the persistence boundary, not actual
        // Talebook cookies or a real plugin exit/restart integration test.
        let cookie_bytes = b"[{\"dummy_fixture_cookie\":\"opaque\"}]";
        fs::write(cache.join(".cookies"), cookie_bytes).unwrap();
        let (authority, doc) = configured_authority(&config, &cache);
        let mut state = authority.lock().unwrap();
        let attempt = state.begin(&doc, 0, a).unwrap();
        state.cancel(&doc, &attempt.attempt_token).unwrap();
        assert_eq!(
            state
                .begin(&doc, 0, source("other", "http://books.example:8080/team/b"))
                .unwrap_err()
                .code,
            "same_hostname_conflict"
        );
        assert!(state
            .begin(&doc, 0, source("b", "https://other.independent/team/b"))
            .is_ok());
        assert_eq!(fs::read(cache.join(".cookies")).unwrap(), cookie_bytes);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn unknown_old_jar_blocks_connection_but_durable_idempotent_taint_allows_legacy_reader() {
        let (root, config, cache) = paths_fixture();
        let cookie_bytes = b"opaque-existing-jar-fixture";
        fs::write(cache.join(".cookies"), cookie_bytes).unwrap();
        let authority = ConnectionAuthority::default();
        assert_eq!(
            authority
                .initialize_paths(config.clone(), cache.clone())
                .unwrap_err()
                .code,
            "source_provenance_unknown"
        );
        authority.main_document_started();
        assert_eq!(
            authority.lock().unwrap().claim_document().unwrap_err().code,
            "source_provenance_unknown"
        );
        assert!(!config.join("server-registry").join(BINDING_FILE).exists());
        authority.mark_reader_attempt().unwrap();
        authority.mark_reader_attempt().unwrap();
        let authority = ConnectionAuthority::default();
        assert_eq!(
            authority
                .initialize_paths(config.clone(), cache.clone())
                .unwrap_err()
                .code,
            "source_provenance_tainted"
        );
        authority.mark_reader_attempt().unwrap();
        assert_eq!(fs::read(cache.join(".cookies")).unwrap(), cookie_bytes);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn early_reader_taint_is_persisted_when_real_paths_become_available() {
        let (root, config, cache) = paths_fixture();
        let authority = ConnectionAuthority::default();
        assert_eq!(
            authority.mark_reader_attempt().unwrap_err().code,
            "source_binding_unavailable"
        );
        assert_eq!(
            authority
                .initialize_paths(config.clone(), cache.clone())
                .unwrap_err()
                .code,
            "source_provenance_tainted"
        );
        let boundary = CookieBoundary::load(config, cache).unwrap();
        assert!(boundary.records.tainted);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn history_write_failure_precedes_any_dispatch_and_preserves_active() {
        let (root, config, cache) = paths_fixture();
        let (authority, doc) = configured_authority(&config, &cache);
        let mut state = authority.lock().unwrap();
        let old = activate(&mut state, &doc, source("old", "https://old.original"));
        let a = source("a", "https://a.example/prefix");
        let attempt = state.begin(&doc, 1, a.clone()).unwrap();
        fs::create_dir_all(config.join("server-registry").join(BINDING_FILE)).unwrap();
        assert_eq!(
            state
                .dispatch(
                    &doc,
                    &attempt.attempt_token,
                    1,
                    "https://a.example/prefix/api/welcome",
                    "GET",
                    &a
                )
                .unwrap_err()
                .code,
            "source_binding_write_failed"
        );
        assert!(state.pending.is_empty());
        assert_eq!(
            state.active.as_ref().unwrap().session_token,
            old.session_token
        );
        assert!(!state.used_hostnames.contains_key("a.example"));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn strict_history_does_not_repair_or_overwrite_unknown_schema_originals() {
        let (root, config, cache) = paths_fixture();
        fs::create_dir(config.join("server-registry")).unwrap();
        let path = config.join("server-registry").join(BINDING_FILE);
        for raw in ["not-json", "{\"version\":2,\"tainted\":false,\"bindings\":[]}", "{\"version\":1,\"tainted\":false,\"bindings\":[],\"extra\":1}", "{\"version\":1,\"tainted\":false,\"bindings\":[{\"hostname\":\"wrong.example\",\"baseUrl\":\"https://books.example/team\"}]}", "{\"version\":1,\"tainted\":false,\"bindings\":[{\"hostname\":\"books.example\",\"baseUrl\":\"https://books.example/team\"},{\"hostname\":\"books.example\",\"baseUrl\":\"https://books.example/other\"}]}"] {
            fs::write(&path, raw).unwrap(); let authority = ConnectionAuthority::default();
            assert_eq!(authority.initialize_paths(config.clone(), cache.clone()).unwrap_err().code, "source_binding_unavailable");
            assert!(authority.mark_reader_attempt().is_err()); assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_jar_baseline_distinguishes_unknown_nonempty_and_empty_binding_placeholder() {
        let (root, config, cache) = paths_fixture();
        for raw in ["", "[]", " \n [] \n"] {
            fs::write(cache.join(".cookies"), raw).unwrap();
            assert!(CookieBoundary::load(config.clone(), cache.clone()).is_ok());
        }
        fs::write(cache.join(".cookies"), "not-an-empty-jar").unwrap();
        assert_eq!(
            CookieBoundary::load(config.clone(), cache.clone())
                .err()
                .unwrap()
                .code,
            "source_provenance_unknown"
        );
        fs::create_dir_all(config.join("server-registry")).unwrap();
        fs::write(
            config.join("server-registry").join(BINDING_FILE),
            "{\"version\":1,\"tainted\":false,\"bindings\":[]}",
        )
        .unwrap();
        assert_eq!(
            CookieBoundary::load(config, cache).err().unwrap().code,
            "source_provenance_unknown"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn binding_count_limit_is_identical_before_write_and_after_cold_load() {
        let (root, config, cache) = paths_fixture();
        let mut boundary = CookieBoundary::load(config.clone(), cache.clone()).unwrap();
        let records = BindingRecords {
            version: 1,
            tainted: false,
            bindings: (0..MAX_HOST_BINDINGS)
                .map(|index| HostBinding {
                    hostname: format!("host-{index}.example-{index}"),
                    base_url: format!("https://host-{index}.example-{index}/prefix"),
                })
                .collect(),
        };
        boundary.persist(records).unwrap();
        let before = fs::read(config.join("server-registry").join(BINDING_FILE)).unwrap();
        assert_eq!(
            boundary
                .bind("overflow.example", "https://overflow.example/prefix")
                .unwrap_err()
                .code,
            "source_binding_write_failed"
        );
        assert_eq!(
            fs::read(config.join("server-registry").join(BINDING_FILE)).unwrap(),
            before
        );
        assert_eq!(
            CookieBoundary::load(config, cache)
                .unwrap()
                .records
                .bindings
                .len(),
            MAX_HOST_BINDINGS
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dns_domain_siblings_parents_and_shared_final_labels_are_conservatively_guarded() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example.com/team/a");
        let attempt = state.begin(&doc, 0, a.clone()).unwrap();
        let pending = request(&mut state, &doc, &attempt);
        state.cancel(&doc, &attempt.attempt_token).unwrap();
        state
            .settle(&doc, &attempt.attempt_token, &pending.request_id, 0)
            .unwrap();
        for base in [
            "https://b.example.com/team/b",
            "https://example.com",
            "https://child.a.example.com",
            "https://unrelated.com/other",
            "https://a.example.com./team/a",
        ] {
            assert_eq!(
                state
                    .begin(&doc, 0, source("other", base))
                    .unwrap_err()
                    .code,
                "same_hostname_conflict",
                "{base}"
            );
        }
        assert!(state
            .begin(&doc, 0, source("other", "https://other.example.net/team/b"))
            .is_ok());
        assert!(!scopes_conflict(
            "127.0.0.1",
            "http://127.0.0.1:43111/a",
            "localhost",
            "http://localhost:43112/b"
        ));
        assert!(scopes_conflict(
            "[::1]",
            "http://[::1]:43111/a",
            "::1",
            "http://[::1]:43112/b"
        ));
    }
    #[test]
    fn cold_ambiguous_domain_history_remains_guarded_and_can_only_be_tainted_for_legacy() {
        let (root, config, cache) = paths_fixture();
        let mut boundary = CookieBoundary::load(config.clone(), cache.clone()).unwrap();
        boundary
            .persist(BindingRecords {
                version: 1,
                tainted: false,
                bindings: vec![
                    HostBinding {
                        hostname: "a.example.com".into(),
                        base_url: "https://a.example.com/team/a".into(),
                    },
                    HostBinding {
                        hostname: "b.example.com".into(),
                        base_url: "https://b.example.com/team/b".into(),
                    },
                ],
            })
            .unwrap();
        assert_eq!(
            CookieBoundary::load(config.clone(), cache.clone())
                .err()
                .unwrap()
                .code,
            "source_provenance_unknown"
        );
        let mut legacy = CookieBoundary::load_records(config.clone(), cache.clone()).unwrap();
        legacy.taint().unwrap();
        assert!(CookieBoundary::load(config, cache).unwrap().records.tainted);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pending_requests_prevent_same_source_mutation_replay_but_allow_parallel_gets() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example/prefix");
        let receipt = activate(&mut state, &doc, a.clone());
        let login = state
            .dispatch(
                &doc,
                &receipt.session_token,
                1,
                "https://a.example/prefix/api/user/login",
                "POST",
                &a,
            )
            .unwrap();
        assert_eq!(
            state
                .dispatch(
                    &doc,
                    &receipt.session_token,
                    1,
                    "https://a.example/prefix/api/user/login",
                    "POST",
                    &a
                )
                .unwrap_err()
                .code,
            "source_busy"
        );
        let read = state
            .dispatch(
                &doc,
                &receipt.session_token,
                1,
                "https://a.example/prefix/api/user/info",
                "GET",
                &a,
            )
            .unwrap();
        state
            .settle(&doc, &receipt.session_token, &read.request_id, 1)
            .unwrap();
        assert_eq!(
            state
                .dispatch(
                    &doc,
                    &receipt.session_token,
                    1,
                    "https://a.example/prefix/api/welcome",
                    "POST",
                    &a
                )
                .unwrap_err()
                .code,
            "source_busy"
        );
        state
            .settle(&doc, &receipt.session_token, &login.request_id, 1)
            .unwrap();
        assert!(state
            .dispatch(
                &doc,
                &receipt.session_token,
                1,
                "https://a.example/prefix/api/welcome",
                "POST",
                &a
            )
            .is_ok());
    }
    #[test]
    fn legacy_get_sign_out_is_a_mutation_until_its_original_request_settles() {
        let (mut state, doc) = initial();
        let a = source("a", "https://a.example/prefix");
        let receipt = activate(&mut state, &doc, a.clone());
        let sign_out = "https://a.example/prefix/api/user/sign_out";
        let logout = state
            .dispatch(&doc, &receipt.session_token, 1, sign_out, "GET", &a)
            .unwrap();
        for url in [
            sign_out,
            &format!("{sign_out}?retry=1"),
            &format!("{sign_out}/"),
        ] {
            assert_eq!(
                state
                    .dispatch(&doc, &receipt.session_token, 1, url, "GET", &a)
                    .unwrap_err()
                    .code,
                "source_busy"
            );
        }
        let read = state
            .dispatch(
                &doc,
                &receipt.session_token,
                1,
                "https://a.example/prefix/api/welcome",
                "GET",
                &a,
            )
            .unwrap();
        state
            .settle(&doc, &receipt.session_token, &logout.request_id, 1)
            .unwrap();
        assert_eq!(
            state
                .dispatch(&doc, &receipt.session_token, 1, sign_out, "GET", &a)
                .unwrap_err()
                .code,
            "source_busy"
        );
        state
            .settle(&doc, &receipt.session_token, &read.request_id, 1)
            .unwrap();
        assert!(state
            .dispatch(&doc, &receipt.session_token, 1, sign_out, "GET", &a)
            .is_ok());
    }
}
