//! Native UIAbility exports, not WebView IPC commands. The forked plugins keep
//! their existing ACL checks before they reach this transport.
use napi_derive_ohos::napi;
use napi_ohos::{
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Status,
};
use tauri_plugin_opener::ohos::{self, OpenRequest};

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
