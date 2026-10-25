//! # Tauri Plugin: Device Info
//!
//! A comprehensive Tauri plugin for accessing device information across all platforms.
//!
//! ## Features
//!
//! - **Device Info**: UUID, manufacturer, model, serial number
//! - **Battery Info**: Charge level, charging status, health
//! - **Network Info**: IP address, network type, MAC address
//! - **Storage Info**: Total/free space, storage type
//! - **Display Info**: Resolution, scale factor, refresh rate
//!
//! ## Supported Platforms
//!
//! | Platform | Status |
//! |----------|--------|
//! | Windows  | ✅     |
//! | macOS    | ✅     |
//! | Linux    | ✅     |
//! | iOS      | ✅     |
//! | Android  | ✅     |
//!
//! ## Usage
//!
//! ```rust,ignore
//! // In your Tauri app's main.rs or lib.rs
//! fn main() {
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_device_info::init())
//!         .run(tauri::generate_context!())
//!         .expect("error while running tauri application");
//! }
//! ```
//!
//! ## JavaScript/TypeScript API
//!
//! ```typescript
//! import { getDeviceInfo, getBatteryInfo } from 'tauri-plugin-device-info-api';
//!
//! const device = await getDeviceInfo();
//! const battery = await getBatteryInfo();
//! ```

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

// Re-export all model types for public API
pub use models::*;

// ============================================================================
// Platform modules
// ============================================================================

#[cfg(all(desktop, not(target_env = "ohos")))]
mod desktop;
#[cfg(all(mobile, not(target_env = "ohos")))]
mod mobile;
#[cfg(target_env = "ohos")]
mod ohos;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(all(desktop, not(target_env = "ohos")))]
use desktop::DeviceInfo;
#[cfg(all(mobile, not(target_env = "ohos")))]
use mobile::DeviceInfo;
#[cfg(target_env = "ohos")]
use ohos::DeviceInfo;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the device-info APIs.
pub trait DeviceInfoExt<R: Runtime> {
    fn device_info(&self) -> &DeviceInfo<R>;
}

impl<R: Runtime, T: Manager<R>> crate::DeviceInfoExt<R> for T {
    fn device_info(&self) -> &DeviceInfo<R> {
        self.state::<DeviceInfo<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device-info")
        .invoke_handler(tauri::generate_handler![
            commands::get_device_info,
            commands::get_battery_info,
            commands::get_network_info,
            commands::get_storage_info,
            commands::get_display_info
        ])
        .setup(|app, api| {
            #[cfg(all(mobile, not(target_env = "ohos")))]
            let device_info = mobile::init(app, api)?;
            #[cfg(all(desktop, not(target_env = "ohos")))]
            let device_info = desktop::init(app, api)?;
            #[cfg(target_env = "ohos")]
            let device_info = ohos::init(app, api)?;
            app.manage(device_info);
            Ok(())
        })
        .build()
}
