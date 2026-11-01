//! LAN discovery is scoped to the host's explicit join page. It never makes
//! HTTP requests, modifies saved servers, or grants the Reader network access.
use serde::Serialize;
#[cfg(not(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
)))]
use serde_json::json;
use serde_json::Value;
use tauri::State;

#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
struct OwnedSession {
    id: String,
    session: moke_discovery_desktop::Session,
}

#[derive(Default)]
pub struct DiscoveryState {
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    session: std::sync::Mutex<Option<OwnedSession>>,
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
        let mut owned = state
            .session
            .lock()
            .map_err(|_| error("error", "discovery state unavailable"))?;
        // Stop/join the previous worker before starting another one. An old
        // stop command can never cancel the replacement session.
        owned.take();
        let session = moke_discovery_desktop::Session::start()
            .map_err(|failure| error(failure.code, failure.message))?;
        let snapshot = serde_json::to_value(session.snapshot())
            .map_err(|_| error("error", "cannot serialize discovery state"))?;
        *owned = Some(OwnedSession {
            id: session_id,
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
            .filter(|current| current.id == session_id)
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
