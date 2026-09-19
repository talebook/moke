//! Preview-only native surface.
//!
//! This module is compiled only with Cargo's `preview` feature. Keep every
//! privileged Preview implementation behind this boundary so stable builds do
//! not merely hide the UI: they omit the native code entirely.

pub(crate) mod entitlement;

#[allow(unused_imports)]
pub(crate) use entitlement::{require_preview_capability, PreviewCapability};

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PREVIEW_BOOTSTRAP_WINDOW: &str = "preview-bootstrap";
const PREVIEW_MAIN_WINDOW: &str = "main";
const ENTITLEMENT_MONITOR_INTERVAL: Duration = Duration::from_secs(1);

static ENTITLEMENT_MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

const UNAUTHENTICATED_COMMANDS: &[&str] = &[
    "moke_build_info",
    "moke_preview_activate",
    "moke_preview_entitlement_status",
    "moke_preview_enter_app",
    "moke_preview_refresh",
];

pub(crate) fn command_requires_entitlement(command: &str) -> bool {
    !UNAUTHENTICATED_COMMANDS.contains(&command)
}

pub(crate) fn authorize_command(app: &tauri::AppHandle, command: &str) -> Result<(), String> {
    if command_requires_entitlement(command) {
        require_preview_capability(app, PreviewCapability::Foundation)
    } else {
        Ok(())
    }
}

fn start_entitlement_monitor(app: tauri::AppHandle) {
    if ENTITLEMENT_MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || loop {
        std::thread::sleep(ENTITLEMENT_MONITOR_INTERVAL);
        if entitlement::revalidate_preview_capability(&app, PreviewCapability::Foundation).is_ok() {
            continue;
        }

        log::warn!("Preview entitlement became invalid; stopping privileged services");
        #[cfg(not(target_env = "ohos"))]
        super::extensions::shutdown(&app);
        // A process restart is intentional: it closes the REST/WS listeners,
        // destroys every privileged WebView and returns to the statically
        // capability-scoped bootstrap window without relying on frontend JS.
        app.request_restart();
        break;
    });
}

#[tauri::command]
pub(crate) async fn moke_preview_enter_app(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let source_label = webview.label();
    if source_label == PREVIEW_MAIN_WINDOW {
        return require_preview_capability(&app, PreviewCapability::Foundation);
    }
    if source_label != PREVIEW_BOOTSTRAP_WINDOW {
        return Err("Preview app entry is available only to the bootstrap window".into());
    }
    // Do not enter the privileged application from a copied or stale offline
    // lease. Every process start must be approved by the entitlement service.
    entitlement::refresh(&app).await?;
    require_preview_capability(&app, PreviewCapability::Foundation)?;
    if app.get_webview_window(PREVIEW_MAIN_WINDOW).is_some() {
        return Err("Preview main window already exists".into());
    }

    let app_for_main_thread = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let main = WebviewWindowBuilder::new(
                &app_for_main_thread,
                PREVIEW_MAIN_WINDOW,
                WebviewUrl::default(),
            )
            .title("墨客 Preview")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .visible(false)
            .build()
            .map_err(|error| format!("Unable to create authorized Preview window: {error}"))?;

            // Close the least-privileged window before extension init installs
            // its process cleanup listener. The hidden main window keeps the
            // application alive throughout the handoff.
            let bootstrap = app_for_main_thread
                .get_webview_window(PREVIEW_BOOTSTRAP_WINDOW)
                .ok_or_else(|| "Preview bootstrap window is unavailable".to_string())?;
            bootstrap
                .close()
                .map_err(|error| format!("Unable to close Preview bootstrap window: {error}"))?;

            #[cfg(not(target_env = "ohos"))]
            super::extensions::init(&app_for_main_thread);
            start_entitlement_monitor(app_for_main_thread.clone());
            main.show()
                .map_err(|error| format!("Unable to show authorized Preview window: {error}"))?;
            main.set_focus()
                .map_err(|error| format!("Unable to focus authorized Preview window: {error}"))?;
            Ok(())
        })();

        if let Err(error) = result {
            log::error!("Preview bootstrap handoff failed: {error}");
            if let Some(main) = app_for_main_thread.get_webview_window(PREVIEW_MAIN_WINDOW) {
                let _ = main.close();
            }
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::command_requires_entitlement;

    #[test]
    fn only_preview_bootstrap_commands_bypass_the_native_gate() {
        for command in [
            "moke_build_info",
            "moke_preview_activate",
            "moke_preview_entitlement_status",
            "moke_preview_enter_app",
            "moke_preview_refresh",
        ] {
            assert!(!command_requires_entitlement(command), "{command}");
        }

        for command in [
            "moke_runtime_platform",
            "moke_list_downloaded_books",
            "open_reader",
            "ext_enable_extension",
            "moke_preview_activate_suffix",
        ] {
            assert!(command_requires_entitlement(command), "{command}");
        }
    }
}
