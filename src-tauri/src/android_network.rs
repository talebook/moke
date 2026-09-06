//! Bridge Android's system proxy selector to the existing Rust HTTP transport.
//! Keep cookies, TLS, streaming and HTTP ACL enforcement in plugin-http.

#[tauri::command]
pub async fn moke_android_proxy(
    webview: tauri::Webview,
    url: String,
) -> Result<Option<String>, String> {
    // Only the host WebView needs this read-only command.
    if webview.label() != "main" {
        return Err("proxy lookup is restricted to the main webview".into());
    }
    let parsed = tauri::Url::parse(&url).map_err(|_| "invalid proxy destination")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("proxy destination must use HTTP(S)".into());
    }

    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            platform.jni_handle().exec(move |env, activity, _| {
                let handles = env
                    .get_java_vm()
                    .and_then(|vm| env.new_global_ref(activity).map(|activity| (vm, activity)))
                    .map_err(|_| "Android proxy bridge initialization failed".to_string());
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = tx.send(handles);
            });
        })
        .map_err(|_| "Android proxy webview unavailable")?;

    // PAC selection may block. Obtain only the JNI handles on the UI thread,
    // then run the Java selector on a worker attached to the VM.
    tauri::async_runtime::spawn_blocking(move || {
        let (vm, activity) = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Android proxy bridge timed out")??;
        let mut env = vm
            .attach_current_thread()
            .map_err(|_| "Android proxy worker initialization failed")?;
        let result = (|| {
            let argument = env.new_string(parsed.as_str())?;
            let value = env
                .call_method(
                    activity.as_obj(),
                    "resolveMokeProxy",
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[(&argument).into()],
                )?
                .l()?;
            if value.is_null() {
                return Ok(None);
            }
            env.get_string(&value.into())
                .map(|value| Some(String::from(value)))
        })();
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        result.map_err(|_| "Android system proxy lookup failed".to_string())
    })
    .await
    .map_err(|_| "Android proxy worker failed")?
}
