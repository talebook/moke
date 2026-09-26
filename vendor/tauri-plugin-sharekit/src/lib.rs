use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(any(
    all(desktop, not(target_os = "macos"), not(target_os = "windows")),
    target_env = "ohos"
))]
mod desktop;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(mobile, not(target_env = "ohos")))]
mod mobile;
#[cfg(target_os = "windows")]
mod windows;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(any(
    all(desktop, not(target_os = "macos"), not(target_os = "windows")),
    target_env = "ohos"
))]
use desktop::ShareKit;
#[cfg(target_os = "macos")]
use macos::ShareKit;
#[cfg(all(mobile, not(target_env = "ohos")))]
use mobile::ShareKit;
#[cfg(target_os = "windows")]
use windows::ShareKit;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`], [`tauri::Webview`] and [`tauri::Window`] to access the share APIs.
pub trait ShareExt<R: Runtime> {
    fn share(&self) -> &ShareKit<R>;
}

impl<R: Runtime, T: Manager<R>> crate::ShareExt<R> for T {
    fn share(&self) -> &ShareKit<R> {
        self.state::<ShareKit<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sharekit")
        .invoke_handler(tauri::generate_handler![
            commands::share_text,
            commands::share_file
        ])
        .setup(|app, api| {
            #[cfg(all(mobile, not(target_env = "ohos")))]
            let share = mobile::init(app, api)?;
            #[cfg(any(
                all(desktop, not(target_os = "macos"), not(target_os = "windows")),
                target_env = "ohos"
            ))]
            let share = desktop::init(app, api)?;
            #[cfg(target_os = "macos")]
            let share = macos::init(app, api)?;
            #[cfg(target_os = "windows")]
            let share = windows::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
