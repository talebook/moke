//! LAN discovery is scoped to the host's explicit join page. It never makes
//! HTTP requests or grants the Reader network access. The save gate can only
//! append one current admitted candidate to the host's fixed registry file.
#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
#[path = "discovery_registry.rs"]
mod registry;
use serde::Serialize;
#[cfg(not(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
)))]
use serde_json::json;
use serde_json::Value;
#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
use tauri::Manager;
use tauri::State;

#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
struct OwnedSession {
    id: String,
    generation: u64,
    session: moke_discovery_desktop::Session,
}

#[derive(Default)]
pub struct DiscoveryState {
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    session: std::sync::Mutex<Option<OwnedSession>>,
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    revocation: std::sync::Mutex<Option<(String, std::sync::Arc<std::sync::atomic::AtomicBool>)>>,
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    start_generation: std::sync::atomic::AtomicU64,
}

#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
fn revoke_before_wait(
    state: &DiscoveryState,
    session_id: Option<&str>,
) -> Result<(), DiscoveryError> {
    let mut revocation = state
        .revocation
        .lock()
        .map_err(|_| error("error", "discovery state unavailable"))?;
    if revocation
        .as_ref()
        .is_some_and(|(id, _)| session_id.map_or(true, |expected| id == expected))
    {
        if let Some((_, stop)) = revocation.take() {
            stop.store(true, std::sync::atomic::Ordering::Release);
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct DiscoveryError {
    code: String,
    message: String,
}

fn error(code: impl Into<String>, message: impl Into<String>) -> DiscoveryError {
    DiscoveryError {
        code: code.into(),
        message: message.into(),
    }
}

fn valid_session_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == value)
}

fn is_join_path(path: &str) -> bool {
    matches!(path, "/join" | "/join/" | "/join.html")
}

fn require_owner(
    webview: &tauri::Webview,
    session_id: &str,
    join_only: bool,
) -> Result<(), DiscoveryError> {
    if !valid_session_id(session_id) {
        return Err(error("invalid_session", "invalid discovery session"));
    }
    if webview.label() != "main" {
        return Err(error(
            "forbidden",
            "discovery is available only in the main window",
        ));
    }
    super::require_moke_shell(webview)
        .map_err(|_| error("forbidden", "discovery is unavailable in the Reader"))?;
    let url = webview
        .url()
        .map_err(|_| error("forbidden", "cannot determine active document"))?;
    if join_only && !is_join_path(url.path()) {
        return Err(error("forbidden", "open the join page to start discovery"));
    }
    Ok(())
}

#[tauri::command]
pub async fn moke_discovery_start(
    webview: tauri::Webview,
    state: State<'_, DiscoveryState>,
    session_id: String,
) -> Result<Value, DiscoveryError> {
    require_owner(&webview, &session_id, true)?;
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        // Publish cancellation before starting sockets or waiting for ownership.
        // Stop can revoke a pending start even before it constructs Session.
        let (generation, stop) = {
            let mut revocation = state
                .revocation
                .lock()
                .map_err(|_| error("error", "discovery state unavailable"))?;
            let generation = state
                .start_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                + 1;
            if let Some((_, previous)) = revocation.take() {
                previous.store(true, std::sync::atomic::Ordering::Release);
            }
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            *revocation = Some((session_id.clone(), stop.clone()));
            (generation, stop)
        };
        let mut owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        // Stop/join the previous worker before starting another one. An old
        // stop command can never cancel the replacement session.
        if state
            .start_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || stop.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(error("stopped", "discovery start was superseded"));
        }
        owned.take();
        let session = moke_discovery_desktop::Session::start_with_revocation(stop.clone())
            .map_err(|failure| error(failure.code, failure.message))?;
        if state
            .start_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || stop.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(error("stopped", "discovery start was superseded"));
        }
        let snapshot = serde_json::to_value(session.snapshot())
            .map_err(|_| error("error", "cannot serialize discovery state"))?;
        *owned = Some(OwnedSession {
            id: session_id,
            generation,
            session,
        });
        Ok(snapshot)
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    )))]
    {
        let _ = state;
        Ok(json!({"status":"unsupported", "rows":[], "error":null}))
    }
}

#[tauri::command]
pub async fn moke_discovery_snapshot(
    webview: tauri::Webview,
    state: State<'_, DiscoveryState>,
    session_id: String,
) -> Result<Value, DiscoveryError> {
    require_owner(&webview, &session_id, true)?;
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        let owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        let current = owned
            .as_ref()
            .filter(|current| {
                current.id == session_id
                    && current.generation
                        == state
                            .start_generation
                            .load(std::sync::atomic::Ordering::Acquire)
            })
            .ok_or_else(|| error("stopped", "discovery session is no longer active"))?;
        serde_json::to_value(current.session.snapshot())
            .map_err(|_| error("error", "cannot serialize discovery state"))
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    )))]
    {
        let _ = state;
        Ok(json!({"status":"unsupported", "rows":[], "error":null}))
    }
}

#[tauri::command]
pub async fn moke_discovery_admit(
    webview: tauri::Webview,
    state: State<'_, DiscoveryState>,
    session_id: String,
    row_id: String,
    base_url: String,
) -> Result<Value, DiscoveryError> {
    require_owner(&webview, &session_id, true)?;
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        let owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        let current = owned
            .as_ref()
            .filter(|current| {
                current.id == session_id
                    && current.generation
                        == state
                            .start_generation
                            .load(std::sync::atomic::Ordering::Acquire)
            })
            .ok_or_else(|| error("stopped", "discovery session is no longer active"))?;
        let admission = current
            .session
            .admit(&row_id, &base_url)
            .map_err(|failure| error(failure.code, failure.message))?;
        require_owner(&webview, &session_id, true)?;
        serde_json::to_value(admission)
            .map_err(|_| error("error", "cannot serialize discovery admission"))
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    )))]
    {
        let _ = (state, row_id, base_url);
        Err(error("unsupported", "当前平台尚不支持发现保存"))
    }
}

#[tauri::command]
pub async fn moke_discovery_commit(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, DiscoveryState>,
    session_id: String,
    admission_id: String,
    expected_raw: Option<String>,
    value: String,
) -> Result<(), DiscoveryError> {
    require_owner(&webview, &session_id, true)?;
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        let config = app
            .path()
            .app_config_dir()
            .map_err(|_| error("storage_io", "服务器列表目录不可用"))?;
        let owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        let current = owned
            .as_ref()
            .filter(|current| {
                current.id == session_id
                    && current.generation
                        == state
                            .start_generation
                            .load(std::sync::atomic::Ordering::Acquire)
            })
            .ok_or_else(|| error("stopped", "discovery session is no longer active"))?;
        current
            .session
            .commit_admission(&admission_id, |base_url, row_id, check| {
                registry::commit_registry(
                    &config,
                    expected_raw.as_deref(),
                    &value,
                    base_url,
                    row_id,
                    || {
                        if current.generation
                            != state
                                .start_generation
                                .load(std::sync::atomic::Ordering::Acquire)
                        {
                            return Err(registry::RegistryError::new(
                                "stopped",
                                "discovery session was superseded",
                            ));
                        }
                        require_owner(&webview, &session_id, true).map_err(|failure| {
                            registry::RegistryError {
                                code: failure.code,
                                message: failure.message,
                            }
                        })?;
                        check().map_err(|failure| registry::RegistryError {
                            code: failure.code,
                            message: failure.message,
                        })
                    },
                )
                .map_err(|failure| moke_discovery_desktop::DiscoveryError {
                    code: failure.code,
                    message: failure.message,
                })
            })
            .map_err(|failure| error(failure.code, failure.message))
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    )))]
    {
        let _ = (app, state, admission_id, expected_raw, value);
        Err(error("unsupported", "当前平台尚不支持发现保存"))
    }
}

#[tauri::command]
pub async fn moke_discovery_stop(
    webview: tauri::Webview,
    state: State<'_, DiscoveryState>,
    session_id: String,
) -> Result<(), DiscoveryError> {
    // Route cleanup may arrive after navigation away from /join. It can only
    // release this exact token and cannot open a socket or obtain results.
    require_owner(&webview, &session_id, false)?;
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        revoke_before_wait(&state, Some(&session_id))?;
        let mut owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        if owned
            .as_ref()
            .is_some_and(|current| current.id == session_id)
        {
            if let Some(mut current) = owned.take() {
                current
                    .session
                    .stop()
                    .map_err(|failure| error(failure.code, failure.message))?;
            }
        }
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    )))]
    let _ = state;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_is_scoped_to_join_document_and_exact_generation() {
        for path in ["/join", "/join/", "/join.html"] {
            assert!(is_join_path(path));
        }
        for path in [
            "/",
            "/welcome",
            "/readest/reader",
            "/join/other",
            "/extensions",
        ] {
            assert!(!is_join_path(path));
        }
        assert!(valid_session_id("9f0c663b-8ffd-4e13-92d9-2b68572c08b1"));
        assert!(!valid_session_id("9F0C663B-8FFD-4E13-92D9-2B68572C08B1"));
        assert!(!valid_session_id("00000000-0000-0000-0000-000000000000"));
    }
}
