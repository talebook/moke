use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use reqwest::{redirect::Policy, StatusCode, Url};
use ring::{
    rand::SystemRandom,
    signature::{self, Ed25519KeyPair, KeyPair},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Webview};

const PROTOCOL_VERSION: u8 = 1;
const REQUIRED_CAPABILITY: &str = "foundation";
const CLOCK_SKEW_SECONDS: u64 = 5 * 60;
const MAX_ONLINE_LEASE_SECONDS: u64 = 48 * 60 * 60;
const MAX_OFFLINE_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_STORED_FILE_BYTES: u64 = 64 * 1024;
const MAX_ACCESS_CODE_BYTES: usize = 4096;
const ENTITLEMENT_DIRECTORY: &str = "preview-entitlement";
const IDENTITY_FILE: &str = "device-identity.json";
const LEASE_FILE: &str = "lease.json";

const SERVICE_URL: Option<&str> = option_env!("MOKE_PREVIEW_ENTITLEMENT_URL");
const SERVICE_PUBLIC_KEY: Option<&str> = option_env!("MOKE_PREVIEW_ENTITLEMENT_PUBLIC_KEY");

static ENTITLEMENT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreviewCapability {
    Foundation,
}

impl PreviewCapability {
    fn as_str(self) -> &'static str {
        match self {
            Self::Foundation => REQUIRED_CAPABILITY,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewEntitlementState {
    NotConfigured,
    Inactive,
    Active,
    OfflineGrace,
    Expired,
    ClockRollback,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewEntitlementStatus {
    state: PreviewEntitlementState,
    service_configured: bool,
    device_id: String,
    subject: Option<String>,
    capabilities: Vec<String>,
    expires_at: Option<u64>,
    offline_until: Option<u64>,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseEnvelope {
    payload: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeasePayload {
    version: u8,
    lease_id: String,
    subject: String,
    device_id: String,
    capabilities: Vec<String>,
    issued_at: u64,
    expires_at: u64,
    offline_until: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseRecord {
    envelope: LeaseEnvelope,
    last_seen_at: u64,
    checkpoint_signature: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceIdentityFile {
    version: u8,
    installation_id: String,
    private_key_pkcs8: String,
}

struct DeviceIdentity {
    installation_id: String,
    device_id: String,
    public_key: String,
    key_pair: Ed25519KeyPair,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceProof {
    nonce: String,
    requested_at: u64,
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest {
    protocol_version: u8,
    device_id: String,
    device_public_key: String,
    installation_id: String,
    app_version: String,
    proof: DeviceProof,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest {
    protocol_version: u8,
    device_id: String,
    installation_id: String,
    app_version: String,
    lease: LeaseEnvelope,
    proof: DeviceProof,
}

struct EntitlementConfig {
    service_url: Url,
    verifier: EntitlementVerifier,
}

struct EntitlementVerifier {
    public_key: [u8; 32],
}

impl EntitlementVerifier {
    fn new(public_key: &[u8]) -> Result<Self, String> {
        let public_key: [u8; 32] = public_key
            .try_into()
            .map_err(|_| "Preview entitlement public key must be 32 bytes".to_string())?;
        Ok(Self { public_key })
    }

    fn verify(
        &self,
        envelope: &LeaseEnvelope,
        expected_device_id: &str,
        now: u64,
    ) -> Result<LeasePayload, String> {
        let payload_bytes = URL_SAFE_NO_PAD
            .decode(&envelope.payload)
            .map_err(|_| "Preview lease payload is not valid base64url".to_string())?;
        if payload_bytes.len() > MAX_RESPONSE_BYTES {
            return Err("Preview lease payload is too large".into());
        }
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(&envelope.signature)
            .map_err(|_| "Preview lease signature is not valid base64url".to_string())?;
        signature::UnparsedPublicKey::new(&signature::ED25519, self.public_key)
            .verify(&payload_bytes, &signature_bytes)
            .map_err(|_| "Preview lease signature is invalid".to_string())?;

        let payload: LeasePayload = serde_json::from_slice(&payload_bytes)
            .map_err(|_| "Preview lease payload is invalid".to_string())?;
        validate_lease_payload(&payload, expected_device_id, now)?;
        Ok(payload)
    }
}

fn validate_lease_payload(
    payload: &LeasePayload,
    expected_device_id: &str,
    now: u64,
) -> Result<(), String> {
    if payload.version != PROTOCOL_VERSION {
        return Err("Preview lease protocol version is unsupported".into());
    }
    if payload.device_id != expected_device_id {
        return Err("Preview lease belongs to a different device".into());
    }
    if payload.lease_id.is_empty() || payload.lease_id.len() > 128 {
        return Err("Preview lease id is invalid".into());
    }
    if payload.subject.is_empty() || payload.subject.len() > 256 {
        return Err("Preview lease subject is invalid".into());
    }
    if payload.capabilities.is_empty()
        || payload.capabilities.len() > 32
        || payload.capabilities.iter().any(|capability| {
            capability.is_empty()
                || capability.len() > 64
                || !capability
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err("Preview lease capabilities are invalid".into());
    }
    if !payload
        .capabilities
        .iter()
        .any(|capability| capability == REQUIRED_CAPABILITY)
    {
        return Err("Preview lease does not grant the required capability".into());
    }
    if payload.issued_at > now.saturating_add(CLOCK_SKEW_SECONDS) {
        return Err("Preview lease was issued in the future".into());
    }
    if payload.expires_at <= payload.issued_at
        || payload.expires_at - payload.issued_at > MAX_ONLINE_LEASE_SECONDS
    {
        return Err("Preview lease online lifetime is invalid".into());
    }
    if payload.offline_until < payload.expires_at
        || payload.offline_until - payload.expires_at > MAX_OFFLINE_WINDOW_SECONDS
    {
        return Err("Preview lease offline window is invalid".into());
    }
    Ok(())
}

fn decode_public_key(value: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(value.trim())
        .or_else(|_| URL_SAFE_NO_PAD.decode(value.trim()))
        .map_err(|_| "Preview entitlement public key is not valid base64".to_string())
}

fn entitlement_config() -> Result<EntitlementConfig, String> {
    let raw_url = SERVICE_URL
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Preview entitlement service URL is not configured".to_string())?;
    let raw_public_key = SERVICE_PUBLIC_KEY
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Preview entitlement public key is not configured".to_string())?;
    let service_url = Url::parse(raw_url)
        .map_err(|_| "Preview entitlement service URL is invalid".to_string())?;
    if service_url.scheme() != "https"
        || !service_url.username().is_empty()
        || service_url.password().is_some()
        || service_url.query().is_some()
        || service_url.fragment().is_some()
    {
        return Err("Preview entitlement service URL must be an HTTPS origin or path".into());
    }
    let public_key = decode_public_key(raw_public_key)?;
    Ok(EntitlementConfig {
        service_url,
        verifier: EntitlementVerifier::new(&public_key)?,
    })
}

fn now_unix() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "System clock is before the Unix epoch".to_string())
}

fn entitlement_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(ENTITLEMENT_DIRECTORY))
        .map_err(|error| format!("Unable to resolve Preview entitlement storage: {error}"))
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Preview entitlement storage cannot be a symbolic link".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Unable to inspect Preview entitlement storage: {error}"
        )),
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    reject_symlink(path)?;
    fs::create_dir_all(path)
        .map_err(|error| format!("Unable to create Preview entitlement storage: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to secure Preview entitlement storage: {error}"))?;
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    reject_symlink(path)?;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to inspect Preview entitlement file: {error}"
            ))
        }
    };
    if !metadata.is_file() || metadata.len() > MAX_STORED_FILE_BYTES {
        return Err("Preview entitlement file is invalid".into());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Unable to read Preview entitlement file: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Preview entitlement file is invalid".to_string())
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Preview entitlement path has no parent".to_string())?;
    ensure_private_directory(parent)?;
    reject_symlink(path)?;
    let bytes = serde_json::to_vec(value)
        .map_err(|_| "Unable to serialize Preview entitlement file".to_string())?;
    if bytes.len() as u64 > MAX_STORED_FILE_BYTES {
        return Err("Preview entitlement file is too large".into());
    }

    let temp_path = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .map_err(|error| format!("Unable to create Preview entitlement file: {error}"))?;
    let write_result = (|| -> Result<(), String> {
        file.write_all(&bytes)
            .map_err(|error| format!("Unable to write Preview entitlement file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Unable to sync Preview entitlement file: {error}"))?;
        drop(file);
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Unable to replace Preview entitlement file: {error}"))?;
        }
        fs::rename(&temp_path, path)
            .map_err(|error| format!("Unable to commit Preview entitlement file: {error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn identity_from_file(file: DeviceIdentityFile) -> Result<DeviceIdentity, String> {
    if file.version != PROTOCOL_VERSION || uuid::Uuid::parse_str(&file.installation_id).is_err() {
        return Err("Preview device identity is invalid".into());
    }
    let private_key = STANDARD
        .decode(file.private_key_pkcs8)
        .map_err(|_| "Preview device identity is invalid".to_string())?;
    let key_pair = Ed25519KeyPair::from_pkcs8(&private_key)
        .map_err(|_| "Preview device identity is invalid".to_string())?;
    Ok(device_identity(file.installation_id, key_pair))
}

fn device_identity(installation_id: String, key_pair: Ed25519KeyPair) -> DeviceIdentity {
    let public_key_bytes = key_pair.public_key().as_ref();
    let device_hash = Sha256::digest(public_key_bytes);
    DeviceIdentity {
        installation_id,
        device_id: format!("moke_{}", URL_SAFE_NO_PAD.encode(device_hash)),
        public_key: URL_SAFE_NO_PAD.encode(public_key_bytes),
        key_pair,
    }
}

fn load_or_create_identity(root: &Path) -> Result<DeviceIdentity, String> {
    let path = root.join(IDENTITY_FILE);
    if let Some(file) = read_json::<DeviceIdentityFile>(&path)? {
        return identity_from_file(file);
    }

    let rng = SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|_| "Unable to generate Preview device identity".to_string())?;
    let file = DeviceIdentityFile {
        version: PROTOCOL_VERSION,
        installation_id: uuid::Uuid::new_v4().to_string(),
        private_key_pkcs8: STANDARD.encode(pkcs8.as_ref()),
    };
    atomic_write_json(&path, &file)?;
    identity_from_file(file)
}

fn proof_message(
    action: &str,
    identity: &DeviceIdentity,
    nonce: &str,
    requested_at: u64,
    app_version: &str,
) -> String {
    format!(
        "moke-preview-{action}-v{PROTOCOL_VERSION}\n{}\n{}\n{}\n{}\n{}",
        identity.device_id, identity.installation_id, nonce, requested_at, app_version
    )
}

fn create_device_proof(
    action: &str,
    identity: &DeviceIdentity,
    requested_at: u64,
    app_version: &str,
) -> DeviceProof {
    let nonce = uuid::Uuid::new_v4().to_string();
    let message = proof_message(action, identity, &nonce, requested_at, app_version);
    DeviceProof {
        nonce,
        requested_at,
        signature: URL_SAFE_NO_PAD.encode(identity.key_pair.sign(message.as_bytes()).as_ref()),
    }
}

fn checkpoint_message(envelope: &LeaseEnvelope, last_seen_at: u64) -> String {
    format!(
        "moke-preview-checkpoint-v{PROTOCOL_VERSION}\n{}\n{}\n{last_seen_at}",
        envelope.payload, envelope.signature
    )
}

fn create_lease_record(
    envelope: LeaseEnvelope,
    last_seen_at: u64,
    identity: &DeviceIdentity,
) -> LeaseRecord {
    let message = checkpoint_message(&envelope, last_seen_at);
    LeaseRecord {
        envelope,
        last_seen_at,
        checkpoint_signature: URL_SAFE_NO_PAD
            .encode(identity.key_pair.sign(message.as_bytes()).as_ref()),
    }
}

fn verify_lease_checkpoint(record: &LeaseRecord, identity: &DeviceIdentity) -> Result<(), String> {
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&record.checkpoint_signature)
        .map_err(|_| "Preview lease checkpoint is invalid".to_string())?;
    let message = checkpoint_message(&record.envelope, record.last_seen_at);
    signature::UnparsedPublicKey::new(&signature::ED25519, identity.key_pair.public_key().as_ref())
        .verify(message.as_bytes(), &signature_bytes)
        .map_err(|_| "Preview lease checkpoint is invalid".to_string())
}

fn checkpoint_predates_lease(record: &LeaseRecord, payload: &LeasePayload) -> bool {
    record.last_seen_at.saturating_add(CLOCK_SKEW_SECONDS) < payload.issued_at
}

fn clock_rollback_detected(record: &LeaseRecord, now: u64) -> bool {
    now.saturating_add(CLOCK_SKEW_SECONDS) < record.last_seen_at
}

fn lease_path(root: &Path) -> PathBuf {
    root.join(LEASE_FILE)
}

fn inactive_status(
    state: PreviewEntitlementState,
    service_configured: bool,
    device_id: String,
    message: impl Into<String>,
) -> PreviewEntitlementStatus {
    PreviewEntitlementStatus {
        state,
        service_configured,
        device_id,
        subject: None,
        capabilities: Vec::new(),
        expires_at: None,
        offline_until: None,
        message: message.into(),
    }
}

fn status_from_payload(
    payload: LeasePayload,
    device_id: String,
    state: PreviewEntitlementState,
    message: impl Into<String>,
) -> PreviewEntitlementStatus {
    PreviewEntitlementStatus {
        state,
        service_configured: true,
        device_id,
        subject: Some(payload.subject),
        capabilities: payload.capabilities,
        expires_at: Some(payload.expires_at),
        offline_until: Some(payload.offline_until),
        message: message.into(),
    }
}

fn entitlement_status_locked(app: &AppHandle) -> Result<PreviewEntitlementStatus, String> {
    let root = entitlement_root(app)?;
    let identity = load_or_create_identity(&root)?;
    let config = match entitlement_config() {
        Ok(config) => config,
        Err(error) => {
            let state = if SERVICE_URL.is_none() || SERVICE_PUBLIC_KEY.is_none() {
                PreviewEntitlementState::NotConfigured
            } else {
                PreviewEntitlementState::Invalid
            };
            return Ok(inactive_status(state, false, identity.device_id, error));
        }
    };
    let path = lease_path(&root);
    let Some(mut record) = read_json::<LeaseRecord>(&path)? else {
        return Ok(inactive_status(
            PreviewEntitlementState::Inactive,
            true,
            identity.device_id,
            "Preview is not activated on this device",
        ));
    };
    let now = now_unix()?;
    if let Err(error) = verify_lease_checkpoint(&record, &identity) {
        return Ok(inactive_status(
            PreviewEntitlementState::Invalid,
            true,
            identity.device_id,
            error,
        ));
    }
    let payload = match config
        .verifier
        .verify(&record.envelope, &identity.device_id, now)
    {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(inactive_status(
                PreviewEntitlementState::Invalid,
                true,
                identity.device_id,
                error,
            ));
        }
    };
    if checkpoint_predates_lease(&record, &payload) {
        return Ok(inactive_status(
            PreviewEntitlementState::Invalid,
            true,
            identity.device_id,
            "Preview lease checkpoint predates the signed lease",
        ));
    }
    if clock_rollback_detected(&record, now) {
        return Ok(status_from_payload(
            payload,
            identity.device_id,
            PreviewEntitlementState::ClockRollback,
            "System clock rollback detected",
        ));
    }
    if now > record.last_seen_at {
        record.last_seen_at = now;
        let message = checkpoint_message(&record.envelope, record.last_seen_at);
        record.checkpoint_signature =
            URL_SAFE_NO_PAD.encode(identity.key_pair.sign(message.as_bytes()).as_ref());
        atomic_write_json(&path, &record)?;
    }
    if now <= payload.expires_at {
        Ok(status_from_payload(
            payload,
            identity.device_id,
            PreviewEntitlementState::Active,
            "Preview entitlement is active",
        ))
    } else if now <= payload.offline_until {
        Ok(status_from_payload(
            payload,
            identity.device_id,
            PreviewEntitlementState::OfflineGrace,
            "Preview entitlement is using its offline grace period",
        ))
    } else {
        Ok(status_from_payload(
            payload,
            identity.device_id,
            PreviewEntitlementState::Expired,
            "Preview entitlement has expired",
        ))
    }
}

fn entitlement_status(app: &AppHandle) -> Result<PreviewEntitlementStatus, String> {
    let _guard = ENTITLEMENT_LOCK
        .lock()
        .map_err(|_| "Preview entitlement lock is unavailable".to_string())?;
    entitlement_status_locked(app)
}

pub(crate) fn require_preview_capability(
    app: &AppHandle,
    capability: PreviewCapability,
) -> Result<(), String> {
    let status = entitlement_status(app)?;
    if !matches!(
        status.state,
        PreviewEntitlementState::Active | PreviewEntitlementState::OfflineGrace
    ) {
        return Err(status.message);
    }
    if !status
        .capabilities
        .iter()
        .any(|granted| granted == capability.as_str())
    {
        return Err("Preview entitlement does not grant this capability".into());
    }
    Ok(())
}

fn service_endpoint(config: &EntitlementConfig, path: &str) -> Result<Url, String> {
    let base = config.service_url.as_str().trim_end_matches('/');
    Url::parse(&format!("{base}{path}"))
        .map_err(|_| "Preview entitlement endpoint is invalid".to_string())
}

async fn send_lease_request<T: Serialize>(
    endpoint: Url,
    body: &T,
    access_code: Option<&str>,
) -> Result<LeaseEnvelope, String> {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Unable to initialize Preview entitlement client".to_string())?;
    let mut request = client.post(endpoint).json(body);
    if let Some(code) = access_code {
        request = request.bearer_auth(code);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Preview entitlement service is unavailable".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                "Preview access code or entitlement was rejected".into()
            }
            StatusCode::TOO_MANY_REQUESTS => {
                "Preview entitlement service rate limit reached".into()
            }
            _ if status.is_server_error() => {
                "Preview entitlement service is temporarily unavailable".into()
            }
            _ => "Preview entitlement request was rejected".into(),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Preview entitlement response is too large".into());
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(MAX_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unable to read Preview entitlement response".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Preview entitlement response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Preview entitlement response is invalid".to_string())
}

fn validate_access_code(access_code: &str) -> Result<&str, String> {
    let access_code = access_code.trim();
    if access_code.is_empty()
        || access_code.len() > MAX_ACCESS_CODE_BYTES
        || access_code.contains(['\r', '\n'])
    {
        return Err("Preview access code is invalid".into());
    }
    Ok(access_code)
}

async fn activate(app: &AppHandle, access_code: &str) -> Result<PreviewEntitlementStatus, String> {
    let access_code = validate_access_code(access_code)?;
    let config = entitlement_config()?;
    let root = entitlement_root(app)?;
    let (identity, request, now) = {
        let _guard = ENTITLEMENT_LOCK
            .lock()
            .map_err(|_| "Preview entitlement lock is unavailable".to_string())?;
        let identity = load_or_create_identity(&root)?;
        let now = now_unix()?;
        let app_version = app.package_info().version.to_string();
        let request = ActivationRequest {
            protocol_version: PROTOCOL_VERSION,
            device_id: identity.device_id.clone(),
            device_public_key: identity.public_key.clone(),
            installation_id: identity.installation_id.clone(),
            app_version: app_version.clone(),
            proof: create_device_proof("activate", &identity, now, &app_version),
        };
        (identity, request, now)
    };
    let endpoint = service_endpoint(&config, "/v1/preview/leases")?;
    let envelope = send_lease_request(endpoint, &request, Some(access_code)).await?;
    config
        .verifier
        .verify(&envelope, &identity.device_id, now)?;
    {
        let _guard = ENTITLEMENT_LOCK
            .lock()
            .map_err(|_| "Preview entitlement lock is unavailable".to_string())?;
        atomic_write_json(
            &lease_path(&root),
            &create_lease_record(envelope, now, &identity),
        )?;
        entitlement_status_locked(app)
    }
}

async fn refresh(app: &AppHandle) -> Result<PreviewEntitlementStatus, String> {
    let config = entitlement_config()?;
    let root = entitlement_root(app)?;
    let (identity, request, now) = {
        let _guard = ENTITLEMENT_LOCK
            .lock()
            .map_err(|_| "Preview entitlement lock is unavailable".to_string())?;
        let identity = load_or_create_identity(&root)?;
        let record = read_json::<LeaseRecord>(&lease_path(&root))?
            .ok_or_else(|| "Preview is not activated on this device".to_string())?;
        verify_lease_checkpoint(&record, &identity)?;
        let now = now_unix()?;
        let payload = config
            .verifier
            .verify(&record.envelope, &identity.device_id, now)?;
        if checkpoint_predates_lease(&record, &payload) {
            return Err("Preview lease checkpoint predates the signed lease".into());
        }
        if clock_rollback_detected(&record, now) {
            return Err("System clock rollback detected".into());
        }
        if now > payload.offline_until {
            return Err("Preview entitlement has expired".into());
        }
        let app_version = app.package_info().version.to_string();
        let request = RefreshRequest {
            protocol_version: PROTOCOL_VERSION,
            device_id: identity.device_id.clone(),
            installation_id: identity.installation_id.clone(),
            app_version: app_version.clone(),
            lease: record.envelope,
            proof: create_device_proof("refresh", &identity, now, &app_version),
        };
        (identity, request, now)
    };
    let endpoint = service_endpoint(&config, "/v1/preview/leases/refresh")?;
    let envelope = send_lease_request(endpoint, &request, None).await?;
    config
        .verifier
        .verify(&envelope, &identity.device_id, now)?;
    {
        let _guard = ENTITLEMENT_LOCK
            .lock()
            .map_err(|_| "Preview entitlement lock is unavailable".to_string())?;
        atomic_write_json(
            &lease_path(&root),
            &create_lease_record(envelope, now, &identity),
        )?;
        entitlement_status_locked(app)
    }
}

#[tauri::command]
pub(crate) fn moke_preview_entitlement_status(
    webview: Webview,
    app: AppHandle,
) -> Result<PreviewEntitlementStatus, String> {
    super::super::require_moke_shell(&webview)?;
    entitlement_status(&app)
}

#[tauri::command]
pub(crate) async fn moke_preview_activate(
    webview: Webview,
    app: AppHandle,
    access_code: String,
) -> Result<PreviewEntitlementStatus, String> {
    super::super::require_moke_shell(&webview)?;
    activate(&app, &access_code).await
}

#[tauri::command]
pub(crate) async fn moke_preview_refresh(
    webview: Webview,
    app: AppHandle,
) -> Result<PreviewEntitlementStatus, String> {
    super::super::require_moke_shell(&webview)?;
    refresh(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_envelope(signer: &Ed25519KeyPair, payload: &LeasePayload) -> LeaseEnvelope {
        let payload_bytes = serde_json::to_vec(payload).unwrap();
        LeaseEnvelope {
            payload: URL_SAFE_NO_PAD.encode(&payload_bytes),
            signature: URL_SAFE_NO_PAD.encode(signer.sign(&payload_bytes).as_ref()),
        }
    }

    fn test_signer() -> Ed25519KeyPair {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    fn valid_payload(now: u64, device_id: &str) -> LeasePayload {
        LeasePayload {
            version: PROTOCOL_VERSION,
            lease_id: "lease-test".into(),
            subject: "preview-tester".into(),
            device_id: device_id.into(),
            capabilities: vec![REQUIRED_CAPABILITY.into()],
            issued_at: now.saturating_sub(10),
            expires_at: now + 60 * 60,
            offline_until: now + 24 * 60 * 60,
        }
    }

    #[test]
    fn signed_lease_is_bound_to_the_expected_device() {
        let now = 1_800_000_000;
        let signer = test_signer();
        let verifier = EntitlementVerifier::new(signer.public_key().as_ref()).unwrap();
        let envelope = signed_envelope(&signer, &valid_payload(now, "device-a"));

        assert!(verifier.verify(&envelope, "device-a", now).is_ok());
        assert_eq!(
            verifier.verify(&envelope, "device-b", now).unwrap_err(),
            "Preview lease belongs to a different device"
        );
    }

    #[test]
    fn modified_payload_or_signature_is_rejected() {
        let now = 1_800_000_000;
        let signer = test_signer();
        let verifier = EntitlementVerifier::new(signer.public_key().as_ref()).unwrap();
        let mut envelope = signed_envelope(&signer, &valid_payload(now, "device-a"));
        let mut payload_bytes = URL_SAFE_NO_PAD.decode(&envelope.payload).unwrap();
        payload_bytes[0] ^= 1;
        envelope.payload = URL_SAFE_NO_PAD.encode(payload_bytes);
        assert_eq!(
            verifier.verify(&envelope, "device-a", now).unwrap_err(),
            "Preview lease signature is invalid"
        );
    }

    #[test]
    fn lease_lifetimes_and_required_capability_are_bounded() {
        let now = 1_800_000_000;
        let mut payload = valid_payload(now, "device-a");
        payload.expires_at = payload.issued_at + MAX_ONLINE_LEASE_SECONDS + 1;
        assert_eq!(
            validate_lease_payload(&payload, "device-a", now).unwrap_err(),
            "Preview lease online lifetime is invalid"
        );

        let mut payload = valid_payload(now, "device-a");
        payload.capabilities = vec!["other".into()];
        assert_eq!(
            validate_lease_payload(&payload, "device-a", now).unwrap_err(),
            "Preview lease does not grant the required capability"
        );
    }

    #[test]
    fn access_codes_reject_empty_oversized_and_header_injection_values() {
        assert!(validate_access_code("valid-code").is_ok());
        assert!(validate_access_code("  ").is_err());
        assert!(validate_access_code("bad\r\nheader").is_err());
        assert!(validate_access_code(&"x".repeat(MAX_ACCESS_CODE_BYTES + 1)).is_err());
    }

    #[test]
    fn device_proof_commits_to_installation_and_request_context() {
        let signer = test_signer();
        let identity = device_identity(uuid::Uuid::new_v4().to_string(), signer);
        let message = proof_message("activate", &identity, "nonce", 1_800_000_000, "1.2.3");
        assert!(message.contains(&identity.device_id));
        assert!(message.contains(&identity.installation_id));
        assert!(message.ends_with("1.2.3"));
    }

    #[test]
    fn lease_checkpoint_rejects_timestamp_and_envelope_tampering() {
        let identity = device_identity(uuid::Uuid::new_v4().to_string(), test_signer());
        let envelope = LeaseEnvelope {
            payload: "signed-payload".into(),
            signature: "service-signature".into(),
        };
        let mut record = create_lease_record(envelope, 1_800_000_000, &identity);

        assert!(verify_lease_checkpoint(&record, &identity).is_ok());
        record.last_seen_at += 1;
        assert_eq!(
            verify_lease_checkpoint(&record, &identity).unwrap_err(),
            "Preview lease checkpoint is invalid"
        );

        record = create_lease_record(record.envelope, 1_800_000_000, &identity);
        record.envelope.payload.push('x');
        assert_eq!(
            verify_lease_checkpoint(&record, &identity).unwrap_err(),
            "Preview lease checkpoint is invalid"
        );
    }

    #[test]
    fn checkpoint_time_guards_detect_rollback_and_prelease_values() {
        let now = 1_800_000_000;
        let identity = device_identity(uuid::Uuid::new_v4().to_string(), test_signer());
        let payload = valid_payload(now, &identity.device_id);
        let envelope = LeaseEnvelope {
            payload: "payload".into(),
            signature: "signature".into(),
        };
        let mut record = create_lease_record(envelope, payload.issued_at, &identity);

        assert!(!checkpoint_predates_lease(&record, &payload));
        record.last_seen_at = payload.issued_at - CLOCK_SKEW_SECONDS - 1;
        assert!(checkpoint_predates_lease(&record, &payload));

        record.last_seen_at = now + CLOCK_SKEW_SECONDS + 1;
        assert!(clock_rollback_detected(&record, now));
    }
}
