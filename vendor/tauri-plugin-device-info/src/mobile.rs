use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_device_info);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<DeviceInfo<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.tauri.plugin.deviceinfo", "DeviceInfo")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_device_info)?;
    Ok(DeviceInfo(handle))
}

/// Access to the device-info APIs.
pub struct DeviceInfo<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> DeviceInfo<R> {
    pub fn get_device_info(&self) -> crate::Result<DeviceInfoResponse> {
        self.0
            .run_mobile_plugin("get_device_info", ())
            .map_err(Into::into)
    }

    pub fn get_battery_info(&self) -> crate::Result<BatteryInfo> {
        self.0
            .run_mobile_plugin("get_battery_info", ())
            .map_err(Into::into)
    }

    pub fn get_network_info(&self) -> crate::Result<NetworkInfo> {
        self.0
            .run_mobile_plugin("get_network_info", ())
            .map_err(Into::into)
    }

    pub fn get_storage_info(&self) -> crate::Result<StorageInfo> {
        self.0
            .run_mobile_plugin("get_storage_info", ())
            .map_err(Into::into)
    }

    pub fn get_display_info(&self) -> crate::Result<DisplayInfo> {
        self.0
            .run_mobile_plugin("get_display_info", ())
            .map_err(Into::into)
    }
}
