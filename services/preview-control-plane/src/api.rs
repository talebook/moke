use crate::{
    crypto,
    error::ApiError,
    model::{
        ActivationRequest, CreateGrantRequest, CreateGrantResponse, HealthResponse, RefreshRequest,
        ServiceInfo, UpdateManifest,
    },
    store::{self, StoreError},
    AppState,
};
use axum::{
    body::Body,
    error_handling::HandleErrorLayer,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    time::Duration,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio_util::io::ReaderStream;
use tower::{limit::ConcurrencyLimitLayer, timeout::TimeoutLayer, BoxError, ServiceBuilder};
use tower_http::{
    catch_panic::CatchPanicLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    sensitive_headers::SetSensitiveRequestHeadersLayer,
    trace::TraceLayer,
};
use url::Url;
use uuid::Uuid;

const MAX_JSON_BODY: usize = 64 * 1024;
const RATE_WINDOW_SECONDS: i32 = 5 * 60;

pub fn router(state: AppState) -> Router {
    let request_id = HeaderName::from_static("x-request-id");
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/preview/info", get(service_info))
        .route("/v1/preview/leases", post(activate))
        .route("/v1/preview/leases/refresh", post(refresh))
        .route(
            "/v1/preview/updates/{target}/{arch}/{current_version}",
            get(update_manifest),
        )
        .route(
            "/v1/preview/artifacts/{version}/{filename}",
            get(download_artifact),
        )
        .route("/v1/admin/grants", post(create_grant))
        .route(
            "/v1/admin/subjects/{subject_id}/revoke",
            post(revoke_subject),
        )
        .route("/v1/admin/devices/{device_id}/revoke", post(revoke_device))
        .route("/v1/admin/releases/{version}", put(publish_release))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY))
        .layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(handle_service_error))
                .layer(TimeoutLayer::new(Duration::from_secs(15)))
                .layer(ConcurrencyLimitLayer::new(128)),
        )
        .layer(TraceLayer::new_for_http())
        .layer(CatchPanicLayer::new())
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        // This is deliberately outermost so tracing never observes the token value.
        .layer(SetSensitiveRequestHeadersLayer::new(std::iter::once(
            header::AUTHORIZATION,
        )))
        .with_state(state)
}

async fn handle_service_error(error: BoxError) -> impl IntoResponse {
    ApiError::internal(error)
}

async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(HealthResponse { status: "ok" }))
}

async fn service_info(State(state): State<AppState>) -> Json<ServiceInfo> {
    Json(ServiceInfo {
        protocol_version: 1,
        lease_public_key: URL_SAFE_NO_PAD.encode(state.lease_public_key),
    })
}

async fn activate(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<ActivationRequest>,
) -> Result<Json<crate::model::LeaseEnvelope>, ApiError> {
    enforce_rate_limit(&state, &format!("activate:ip:{}", peer.ip()), 20).await?;
    let access_code = bearer(&headers).ok_or_else(ApiError::unauthorized)?;
    let lookup = crypto::access_code_lookup(&state.access_code_pepper, access_code)?;
    enforce_rate_limit(
        &state,
        &format!("activate:code:{}", URL_SAFE_NO_PAD.encode(lookup)),
        10,
    )
    .await?;
    let record = store::find_access_code(&state.pool, &lookup)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let now = crypto::now_unix();
    if record.disabled_at.is_some()
        || record
            .expires_at
            .is_some_and(|expires| expires.unix_timestamp() <= now)
    {
        return Err(ApiError::unauthorized());
    }
    let encoded_hash = record.verifier_hash.clone();
    let code = access_code.to_owned();
    let valid =
        tokio::task::spawn_blocking(move || crypto::verify_access_code(&code, &encoded_hash))
            .await
            .map_err(ApiError::internal)?;
    if !valid {
        return Err(ApiError::unauthorized());
    }

    let public_key = crypto::decode_public_key(&request.device_public_key)?;
    let nonce = crypto::validate_device_request(
        "activate",
        request.protocol_version,
        &request.device_id,
        request.installation_id,
        &request.app_version,
        &request.proof,
        &public_key,
        now,
    )?;
    let issued_at = OffsetDateTime::from_unix_timestamp(now).map_err(ApiError::internal)?;
    let expires_at = issued_at + time::Duration::seconds(state.lease_ttl_seconds);
    let lease_id = Uuid::new_v4();
    store::activate_device(
        &state.pool,
        record.id,
        record.subject_id,
        &request.device_id,
        request.installation_id,
        &public_key,
        &request.app_version,
        nonce,
        lease_id,
        issued_at,
        expires_at,
    )
    .await
    .map_err(map_store_error)?;
    Ok(Json(crypto::sign_lease(
        &state.lease_signer,
        lease_id,
        record.subject_id,
        request.device_id,
        issued_at.unix_timestamp(),
        expires_at.unix_timestamp(),
    )?))
}

async fn refresh(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<RefreshRequest>,
) -> Result<Json<crate::model::LeaseEnvelope>, ApiError> {
    enforce_rate_limit(&state, &format!("refresh:ip:{}", peer.ip()), 120).await?;
    let previous = crypto::verify_lease(&state.lease_public_key, &request.lease)?;
    if previous.device_id != request.device_id {
        return Err(ApiError::unauthorized());
    }
    let subject_id = Uuid::parse_str(&previous.subject).map_err(|_| ApiError::unauthorized())?;
    let previous_lease_id =
        Uuid::parse_str(&previous.lease_id).map_err(|_| ApiError::unauthorized())?;
    let public_key = store::device_public_key(&state.pool, &request.device_id)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let now = crypto::now_unix();
    let nonce = crypto::validate_device_request(
        "refresh",
        request.protocol_version,
        &request.device_id,
        request.installation_id,
        &request.app_version,
        &request.proof,
        &public_key,
        now,
    )?;
    enforce_rate_limit(&state, &format!("refresh:device:{}", request.device_id), 60).await?;
    let issued_at = OffsetDateTime::from_unix_timestamp(now).map_err(ApiError::internal)?;
    let expires_at = issued_at + time::Duration::seconds(state.lease_ttl_seconds);
    let next_lease_id = Uuid::new_v4();
    store::refresh_device(
        &state.pool,
        subject_id,
        &request.device_id,
        request.installation_id,
        &public_key,
        &request.app_version,
        nonce,
        previous_lease_id,
        next_lease_id,
        issued_at,
        expires_at,
    )
    .await
    .map_err(map_store_error)?;
    Ok(Json(crypto::sign_lease(
        &state.lease_signer,
        next_lease_id,
        subject_id,
        request.device_id,
        issued_at.unix_timestamp(),
        expires_at.unix_timestamp(),
    )?))
}

async fn update_manifest(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((target, arch, current_version)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    enforce_rate_limit(&state, &format!("update:ip:{}", peer.ip()), 120).await?;
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ApiError::unauthorized)?;
    let now = crypto::now_unix();
    let (claims, public_key, nonce) = crypto::verify_update_authorization(authorization, now)?;
    if claims.app_version != current_version {
        return Err(ApiError::unauthorized());
    }
    enforce_rate_limit(&state, &format!("update:device:{}", claims.device_id), 60).await?;
    store::authorize_update(
        &state.pool,
        &claims,
        &public_key,
        nonce,
        OffsetDateTime::from_unix_timestamp(now).map_err(ApiError::internal)?,
    )
    .await
    .map_err(map_store_error)?;

    let platform = normalized_platform(&target, &arch)?;
    if platform.starts_with("darwin-") {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let current_version = semver::Version::parse(&current_version)
        .map_err(|_| ApiError::bad_request("INVALID_VERSION"))?;
    let Some(mut manifest) = store::latest_manifest(&state.pool, &current_version).await? else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let Some(mut artifact) = manifest.platforms.remove(&platform) else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let original = Url::parse(&artifact.url)
        .map_err(|_| ApiError::internal("stored artifact URL is invalid"))?;
    let filename = original
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .filter(|filename| valid_filename(filename))
        .ok_or_else(|| ApiError::internal("stored artifact filename is invalid"))?;
    let expires_at = now + 5 * 60;
    let token = crypto::artifact_token(
        &state.artifact_url_key,
        &manifest.version,
        filename,
        &claims.device_id,
        expires_at,
    )?;
    let mut url = state
        .public_base_url
        .join(&format!(
            "v1/preview/artifacts/{}/{filename}",
            manifest.version
        ))
        .map_err(ApiError::internal)?;
    url.query_pairs_mut()
        .append_pair("expires", &expires_at.to_string())
        .append_pair("device", &claims.device_id)
        .append_pair("token", &token);
    artifact.url = url.into();
    manifest.platforms = BTreeMap::from([(platform, artifact)]);
    let mut response = Json(manifest).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[derive(Deserialize)]
struct ArtifactQuery {
    expires: i64,
    device: String,
    token: String,
}

async fn download_artifact(
    State(state): State<AppState>,
    Path((version, filename)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Response, ApiError> {
    let now = crypto::now_unix();
    if semver::Version::parse(&version).is_err()
        || !valid_filename(&filename)
        || !valid_device_id(&query.device)
        || query.expires < now
        || query.expires > now + 10 * 60
        || !crypto::verify_artifact_token(
            &state.artifact_url_key,
            &version,
            &filename,
            &query.device,
            query.expires,
            &query.token,
        )
    {
        return Err(ApiError::unauthorized());
    }
    let path = checked_artifact_path(&state.artifact_root, &version, &filename).await?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ApiError::not_found(),
            _ => ApiError::internal(error),
        })?;
    let metadata = file.metadata().await.map_err(ApiError::internal)?;
    if !metadata.is_file() {
        return Err(ApiError::not_found());
    }
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.len().to_string()).map_err(ApiError::internal)?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .map_err(ApiError::internal)?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn create_grant(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CreateGrantRequest>,
) -> Result<Response, ApiError> {
    enforce_rate_limit(&state, &format!("admin:ip:{}", peer.ip()), 60).await?;
    require_admin(&state, &headers)?;
    let label = request.label.trim();
    let now = crypto::now_unix();
    let expires_at = match request.expires_at {
        Some(expires) if expires > now && expires <= now + 366 * 24 * 60 * 60 => Some(
            OffsetDateTime::from_unix_timestamp(expires)
                .map_err(|_| ApiError::bad_request("INVALID_EXPIRY"))?,
        ),
        Some(_) => return Err(ApiError::bad_request("INVALID_EXPIRY")),
        None => None,
    };
    if label.is_empty() || label.len() > 200 || !(1..=100).contains(&request.device_limit) {
        return Err(ApiError::bad_request("INVALID_GRANT"));
    }
    let access_code = crypto::generate_access_code();
    let lookup = crypto::access_code_lookup(&state.access_code_pepper, &access_code)?;
    let code_for_hash = access_code.clone();
    let verifier = tokio::task::spawn_blocking(move || crypto::hash_access_code(&code_for_hash))
        .await
        .map_err(ApiError::internal)??;
    let subject_id = Uuid::new_v4();
    store::create_grant(
        &state.pool,
        subject_id,
        label,
        request.device_limit,
        Uuid::new_v4(),
        &lookup,
        &verifier,
        expires_at,
    )
    .await?;
    let mut response = Json(CreateGrantResponse {
        subject_id,
        access_code,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn revoke_subject(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(subject_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    enforce_rate_limit(&state, &format!("admin:ip:{}", peer.ip()), 60).await?;
    require_admin(&state, &headers)?;
    if store::revoke_subject(&state.pool, subject_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
}

async fn revoke_device(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    enforce_rate_limit(&state, &format!("admin:ip:{}", peer.ip()), 60).await?;
    require_admin(&state, &headers)?;
    if !valid_device_id(&device_id) {
        return Err(ApiError::bad_request("INVALID_DEVICE_ID"));
    }
    if store::revoke_device(&state.pool, &device_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
}

async fn publish_release(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(version): Path<String>,
    Json(manifest): Json<UpdateManifest>,
) -> Result<StatusCode, ApiError> {
    enforce_rate_limit(&state, &format!("admin:ip:{}", peer.ip()), 60).await?;
    require_admin(&state, &headers)?;
    if manifest.version != version
        || semver::Version::parse(&version).is_err()
        || manifest.notes.len() > 64 * 1024
        || OffsetDateTime::parse(&manifest.pub_date, &Rfc3339).is_err()
        || manifest.platforms.is_empty()
        || manifest.platforms.len() > 8
    {
        return Err(ApiError::bad_request("INVALID_RELEASE"));
    }
    for (platform, artifact) in &manifest.platforms {
        if !matches!(
            platform.as_str(),
            "linux-x86_64" | "linux-aarch64" | "windows-x86_64"
        ) || artifact.signature.is_empty()
            || artifact.signature.len() > 16 * 1024
            || artifact.signature.contains(['\r', '\n'])
        {
            return Err(ApiError::bad_request("INVALID_RELEASE"));
        }
        let url =
            Url::parse(&artifact.url).map_err(|_| ApiError::bad_request("INVALID_RELEASE"))?;
        if !same_origin(&url, &state.public_base_url) {
            return Err(ApiError::bad_request("INVALID_RELEASE"));
        }
        let filename = url
            .path_segments()
            .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
            .filter(|filename| valid_filename(filename))
            .ok_or_else(|| ApiError::bad_request("INVALID_RELEASE"))?;
        checked_artifact_path(&state.artifact_root, &version, filename).await?;
    }
    store::upsert_manifest(&state.pool, &manifest).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn enforce_rate_limit(state: &AppState, bucket: &str, limit: i32) -> Result<(), ApiError> {
    if store::consume_rate_limit(&state.pool, bucket, limit, RATE_WINDOW_SECONDS).await? {
        Ok(())
    } else {
        Err(ApiError::rate_limited())
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|value| !value.is_empty())
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let token = bearer(headers).ok_or_else(ApiError::unauthorized)?;
    if crypto::admin_token_matches(&state.admin_token, token) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn map_store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::Rejected | StoreError::DeviceLimit => ApiError::forbidden(),
        StoreError::Replay => ApiError::conflict("REPLAY_REJECTED"),
        StoreError::LeaseConsumed => ApiError::conflict("LEASE_ALREADY_REFRESHED"),
        StoreError::Database(error) => ApiError::internal(error),
    }
}

fn normalized_platform(target: &str, arch: &str) -> Result<String, ApiError> {
    let target = match target {
        "linux" => "linux",
        "windows" => "windows",
        "darwin" | "macos" => "darwin",
        _ => return Err(ApiError::bad_request("UNSUPPORTED_PLATFORM")),
    };
    let arch = match arch {
        "x86_64" | "x64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        _ => return Err(ApiError::bad_request("UNSUPPORTED_PLATFORM")),
    };
    Ok(format!("{target}-{arch}"))
}

fn valid_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_device_id(value: &str) -> bool {
    value.len() == 48
        && value.starts_with("moke_")
        && value[5..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == "https"
        && left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.username().is_empty()
        && left.password().is_none()
        && left.query().is_none()
        && left.fragment().is_none()
}

async fn checked_artifact_path(
    root: &FsPath,
    version: &str,
    filename: &str,
) -> Result<PathBuf, ApiError> {
    if semver::Version::parse(version).is_err() || !valid_filename(filename) {
        return Err(ApiError::bad_request("INVALID_ARTIFACT_PATH"));
    }
    let canonical_root =
        tokio::fs::canonicalize(root)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => ApiError::not_found(),
                _ => ApiError::internal(error),
            })?;
    let candidate = root.join(version).join(filename);
    let canonical_candidate =
        tokio::fs::canonicalize(&candidate)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => ApiError::not_found(),
                _ => ApiError::internal(error),
            })?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(ApiError::bad_request("INVALID_ARTIFACT_PATH"));
    }
    let metadata = tokio::fs::symlink_metadata(&candidate)
        .await
        .map_err(ApiError::internal)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ApiError::not_found());
    }
    Ok(canonical_candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_and_path_inputs_are_narrow() {
        assert_eq!(
            normalized_platform("linux", "amd64").unwrap(),
            "linux-x86_64"
        );
        assert_eq!(
            normalized_platform("macos", "arm64").unwrap(),
            "darwin-aarch64"
        );
        assert!(normalized_platform("freebsd", "x64").is_err());
        assert!(valid_filename("Moke_1.2.3_amd64.AppImage"));
        assert!(!valid_filename("../Moke.AppImage"));
        assert!(!valid_filename("Moke AppImage"));
    }

    #[test]
    fn manifest_origin_cannot_carry_credentials_or_tokens() {
        let base = Url::parse("https://preview.example.test/control/").unwrap();
        assert!(same_origin(
            &Url::parse("https://preview.example.test/artifacts/Moke.AppImage").unwrap(),
            &base,
        ));
        assert!(!same_origin(
            &Url::parse("https://preview.example.test/artifacts/a?token=x").unwrap(),
            &base,
        ));
        assert!(!same_origin(
            &Url::parse("https://evil.example/artifacts/Moke.AppImage").unwrap(),
            &base,
        ));
    }
}
