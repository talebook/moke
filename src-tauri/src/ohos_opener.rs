//! Native UIAbility exports, not WebView IPC commands. The forked plugins keep
//! their existing ACL checks before they reach this transport.
use napi_derive_ohos::napi;
use napi_ohos::{
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Error, Result, Status,
};
use std::path::Path;
use tauri_plugin_opener::ohos::{self, OpenRequest};

/// Set XDG roots before RustAbility starts Tauri. The Linux-style `dirs`
/// fallback on OHOS otherwise resolves AppData under /storage/Users/currentUser,
/// where creating a file may work but renaming it is denied by the sandbox.
#[napi]
pub fn configure_ohos_app_storage(files_dir: String, cache_dir: String) -> Result<()> {
    if !Path::new(&files_dir).is_absolute() || !Path::new(&cache_dir).is_absolute() {
        return Err(Error::new(
            Status::InvalidArg,
            "OHOS app directories must be absolute",
        ));
    }
    std::env::set_var("XDG_DATA_HOME", &files_dir);
    std::env::set_var("XDG_CONFIG_HOME", &files_dir);
    std::env::set_var("XDG_CACHE_HOME", &cache_dir);
    Ok(())
}

#[napi]
pub fn register_ohos_opener(
    callback: ThreadsafeFunction<String, (), String, Status, false, false, 64>,
) {
    ohos::register(move |id, request| {
        let (kind, value) = match request {
            OpenRequest::Url(value) => ("url", value),
            OpenRequest::Path(value) => ("path", value),
        };
        let payload = serde_json::json!({ "id": id, "kind": kind, "value": value });
        let status = callback.call(payload.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
        if status == Status::Ok {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "OHOS opener queue: {status:?}"
            )))
        }
    });
}

#[napi]
pub fn complete_ohos_opener(id: u32, error: Option<String>) {
    ohos::complete(id, error);
}

#[napi]
pub fn is_ohos_opener_pending(id: u32) -> bool {
    ohos::is_pending(id)
}

#[napi]
pub fn unregister_ohos_opener() {
    ohos::unregister();
}
