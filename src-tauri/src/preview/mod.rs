//! Preview-only native surface.
//!
//! This module is compiled only with Cargo's `preview` feature. Keep every
//! privileged Preview implementation behind this boundary so stable builds do
//! not merely hide the UI: they omit the native code entirely.

mod device_credential;
pub(crate) mod entitlement;

#[allow(unused_imports)]
pub(crate) use entitlement::{require_preview_capability, PreviewCapability};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::utils::config::Color;
#[cfg(not(target_env = "ohos"))]
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PREVIEW_BOOTSTRAP_WINDOW: &str = "preview-bootstrap";
const PREVIEW_MAIN_WINDOW: &str = "main";
const ENTITLEMENT_MONITOR_INTERVAL: Duration = Duration::from_secs(1);
const HANDOFF_LOAD_TIMEOUT: Duration = Duration::from_secs(30);

static ENTITLEMENT_MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
type HandoffReady = Arc<Mutex<Option<tauri::async_runtime::Sender<Result<(), String>>>>>;

fn complete_handoff(ready: &HandoffReady, result: Result<(), String>) {
    if let Some(sender) = ready.lock().ok().and_then(|mut sender| sender.take()) {
        let _ = sender.try_send(result);
    }
}

fn startup_background(appearance: Option<&str>) -> Color {
    match appearance {
        Some("dark") => Color(26, 24, 20, 255),
        Some("eink") => Color(255, 255, 255, 255),
        _ => Color(251, 250, 243, 255),
    }
}

// Keep the existing bootstrap painted until the authorized document has
// loaded its CSS and HTML. A hidden WebView can load without being shown.
fn reveal_preview_main(app: tauri::AppHandle, ready: HandoffReady) {
    let app_for_main_thread = app.clone();
    let ready_for_main_thread = ready.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        // A timed-out or already completed callback cannot reveal a window.
        if !ready_for_main_thread
            .lock()
            .map(|sender| sender.is_some())
            .unwrap_or(false)
        {
            return;
        }
        let result = (|| -> Result<(), String> {
            require_preview_capability(&app_for_main_thread, PreviewCapability::Foundation)?;
            let main = app_for_main_thread
                .get_webview_window(PREVIEW_MAIN_WINDOW)
                .ok_or_else(|| "Preview main window is unavailable".to_string())?;
            let Some(bootstrap) = app_for_main_thread.get_webview_window(PREVIEW_BOOTSTRAP_WINDOW)
            else {
                // Later navigations must not reinitialize extension listeners.
                return Ok(());
            };
            main.show()
                .map_err(|error| format!("Unable to show authorized Preview window: {error}"))?;
            bootstrap
                .close()
                .map_err(|error| format!("Unable to close Preview bootstrap window: {error}"))?;
            // Close the restricted window before installing process cleanup.
            #[cfg(not(target_env = "ohos"))]
            super::extensions::init(&app_for_main_thread);
            start_entitlement_monitor(app_for_main_thread.clone());
            if let Err(error) = main.set_focus() {
                log::warn!("Unable to focus authorized Preview window: {error}");
            }
            Ok(())
        })();
        if let Err(error) = &result {
            log::error!("Preview loaded-window handoff failed: {error}");
            if let Some(main) = app_for_main_thread.get_webview_window(PREVIEW_MAIN_WINDOW) {
                let _ = main.close();
            }
        }
        complete_handoff(&ready_for_main_thread, result);
    }) {
        log::error!("Unable to schedule Preview loaded-window handoff: {error}");
        complete_handoff(&ready, Err(error.to_string()));
    }
}

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
    appearance: Option<String>,
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
    let background = startup_background(appearance.as_deref());
    let (ready_sender, mut ready_receiver) = tauri::async_runtime::channel(1);
    let ready: HandoffReady = Arc::new(Mutex::new(Some(ready_sender)));
    let ready_for_timeout = Arc::downgrade(&ready);
    app.run_on_main_thread(move || {
        #[cfg(not(target_env = "ohos"))]
        let ready_for_load = ready.clone();
        let result = (|| -> Result<(), String> {
            let builder = WebviewWindowBuilder::new(
                &app_for_main_thread,
                PREVIEW_MAIN_WINDOW,
                WebviewUrl::default(),
            )
            .title("墨客 Preview")
            .inner_size(1280.0, 800.0)
            .resizable(true)
            .visible(false)
            .background_color(background);
            #[cfg(not(target_env = "ohos"))]
            let builder = builder.on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    reveal_preview_main(window.app_handle().clone(), ready_for_load.clone());
                }
            });
            // Mobile hosts own their WebView size and do not implement desktop
            // geometry queries. Preserve the actual bootstrap size on desktop.
            #[cfg(not(any(target_os = "android", target_os = "ios", target_env = "ohos")))]
            let builder = {
                let bootstrap = app_for_main_thread
                    .get_webview_window(PREVIEW_BOOTSTRAP_WINDOW)
                    .ok_or_else(|| "Preview bootstrap window is unavailable".to_string())?;
                let scale = bootstrap.scale_factor().unwrap_or(1.0);
                let mut builder = builder;
                if let Ok(size) = bootstrap.inner_size() {
                    builder =
                        builder.inner_size(size.width as f64 / scale, size.height as f64 / scale);
                }
                // Wayland may not expose an outer position. Cosmetic geometry
                // queries must not prevent an otherwise authorized startup.
                if let Ok(position) = bootstrap.outer_position() {
                    builder =
                        builder.position(position.x as f64 / scale, position.y as f64 / scale);
                }
                builder
                    .maximized(bootstrap.is_maximized().unwrap_or(false))
                    .fullscreen(bootstrap.is_fullscreen().unwrap_or(false))
            };
            let main = builder
                .build()
                .map_err(|error| format!("Unable to create authorized Preview window: {error}"))?;
            let ready_for_close = ready.clone();
            main.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    complete_handoff(
                        &ready_for_close,
                        Err("Preview window closed before completing startup".into()),
                    );
                }
            });
            // This pinned ArkWeb backend does not dispatch page-load events.
            // Keep its existing handoff until the backend gains that callback.
            #[cfg(target_env = "ohos")]
            reveal_preview_main(app_for_main_thread.clone(), ready.clone());
            Ok(())
        })();

        if let Err(error) = result {
            log::error!("Preview bootstrap handoff failed: {error}");
            if let Some(main) = app_for_main_thread.get_webview_window(PREVIEW_MAIN_WINDOW) {
                let _ = main.close();
            }
            complete_handoff(&ready, Err(error));
        }
    })
    .map_err(|error| error.to_string())?;
    let app_for_timeout = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HANDOFF_LOAD_TIMEOUT);
        let Some(ready) = ready_for_timeout.upgrade() else {
            return;
        };
        let app_for_main_thread = app_for_timeout.clone();
        let ready_for_error = ready.clone();
        if let Err(error) = app_for_timeout.run_on_main_thread(move || {
            let Some(sender) = ready.lock().ok().and_then(|mut sender| sender.take()) else {
                return;
            };
            if let Some(main) = app_for_main_thread.get_webview_window(PREVIEW_MAIN_WINDOW) {
                let _ = main.close();
            }
            let _ = sender.try_send(Err("打开墨客超时，请重试。".into()));
        }) {
            log::error!("Unable to recover a stalled Preview handoff: {error}");
            complete_handoff(&ready_for_error, Err(error.to_string()));
        }
    });
    ready_receiver
        .recv()
        .await
        .ok_or_else(|| "Preview window closed before completing startup".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{command_requires_entitlement, complete_handoff, startup_background, HandoffReady};
    use std::sync::{Arc, Mutex};

    #[test]
    fn handoff_uses_only_known_backgrounds() {
        for (appearance, expected) in [
            (None, (251, 250, 243, 255)),
            (Some("light"), (251, 250, 243, 255)),
            (Some("dark"), (26, 24, 20, 255)),
            (Some("eink"), (255, 255, 255, 255)),
            (Some("invalid"), (251, 250, 243, 255)),
        ] {
            let color = startup_background(appearance);
            assert_eq!((color.0, color.1, color.2, color.3), expected);
        }
    }

    #[test]
    fn completed_handoff_ignores_late_load_and_timeout_results() {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let ready: HandoffReady = Arc::new(Mutex::new(Some(sender)));
        complete_handoff(&ready, Ok(()));
        complete_handoff(&ready, Err("late timeout".into()));
        assert_eq!(receiver.try_recv().unwrap(), Ok(()));
        assert!(receiver.try_recv().is_err());
        assert!(ready.lock().unwrap().is_none());
    }

    #[test]
    fn failed_handoff_returns_the_error_for_frontend_retry() {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let ready: HandoffReady = Arc::new(Mutex::new(Some(sender)));
        complete_handoff(&ready, Err("load failed".into()));
        complete_handoff(&ready, Ok(()));
        assert_eq!(receiver.try_recv().unwrap(), Err("load failed".into()));
    }

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
