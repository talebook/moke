use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::DeviceInfoExt;
use crate::Result;

#[command]
pub(crate) async fn get_device_info<R: Runtime>(app: AppHandle<R>) -> Result<DeviceInfoResponse> {
    app.device_info().get_device_info()
}

#[command]
pub(crate) async fn get_battery_info<R: Runtime>(app: AppHandle<R>) -> Result<BatteryInfo> {
    app.device_info().get_battery_info()
}

#[command]
pub(crate) async fn get_network_info<R: Runtime>(app: AppHandle<R>) -> Result<NetworkInfo> {
    app.device_info().get_network_info()
}

#[command]
pub(crate) async fn get_storage_info<R: Runtime>(app: AppHandle<R>) -> Result<StorageInfo> {
    app.device_info().get_storage_info()
}

#[command]
pub(crate) async fn get_display_info<R: Runtime>(app: AppHandle<R>) -> Result<DisplayInfo> {
    app.device_info().get_display_info()
}
