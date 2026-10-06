//! OpenHarmony fallback for the device-info plugin.
//!
//! The upstream mobile implementation can only register Android and iOS
//! plugins. Tauri classifies OpenHarmony as mobile too, so selecting that
//! implementation leaves its native plugin handle undefined. Keep the IPC
//! commands registered on OpenHarmony and return empty information until a
//! native OpenHarmony implementation is available.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<DeviceInfo<R>> {
    Ok(DeviceInfo(PhantomData))
}

pub struct DeviceInfo<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> DeviceInfo<R> {
    pub fn get_device_info(&self) -> crate::Result<DeviceInfoResponse> {
        Ok(DeviceInfoResponse::default())
    }

    pub fn get_battery_info(&self) -> crate::Result<BatteryInfo> {
        Ok(BatteryInfo::default())
    }

    pub fn get_network_info(&self) -> crate::Result<NetworkInfo> {
        Ok(NetworkInfo::default())
    }

    pub fn get_storage_info(&self) -> crate::Result<StorageInfo> {
        Ok(StorageInfo::default())
    }

    pub fn get_display_info(&self) -> crate::Result<DisplayInfo> {
        Ok(DisplayInfo::default())
    }
}
