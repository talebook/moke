//! Data models for the device-info plugin.
//!
//! This module contains all the response types returned by the plugin's API.
//! All types implement `Serialize` and `Deserialize` for JSON communication
//! with the frontend, and use `camelCase` naming for JavaScript compatibility.

use serde::{Deserialize, Serialize};

// ============================================================================
// Device Information
// ============================================================================

/// Comprehensive device identification and hardware information.
///
/// Contains unique identifiers and basic hardware details that can be used
/// for device fingerprinting, analytics, or user identification.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct DeviceInfoResponse {
    /// Unique device identifier (Hardware UUID or GUID)
    pub uuid: Option<String>,
    /// Device manufacturer (e.g., "Apple Inc.", "Dell Inc.")
    pub manufacturer: Option<String>,
    /// Device model name (e.g., "MacBook Pro", "OptiPlex 7090")
    pub model: Option<String>,
    /// Device serial number (may be restricted on some platforms)
    pub serial: Option<String>,
    /// Android-specific device ID (Android only)
    pub android_id: Option<String>,
    /// User-assigned device name (hostname)
    pub device_name: Option<String>,
}

// ============================================================================
// Battery Information
// ============================================================================

/// Battery status and health information.
///
/// Provides real-time battery metrics including charge level, charging state,
/// and overall battery health assessment.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    /// Current battery charge level (0-100 percentage)
    pub level: Option<f32>,
    /// Whether the device is currently connected to power and charging
    pub is_charging: Option<bool>,
    /// Battery health status (e.g., "Good", "Fair", "Poor")
    pub health: Option<String>,
}

// ============================================================================
// Network Information
// ============================================================================

/// Network connection details and identifiers.
///
/// Contains information about the current network connection including
/// IP address, connection type, and hardware address.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    /// Local IPv4 address (e.g., "192.168.1.100")
    pub ip_address: Option<String>,
    /// Connection type: "wifi", "ethernet", "cellular", or "unknown"
    pub network_type: Option<String>,
    /// MAC address (unavailable on iOS/Android due to privacy restrictions)
    pub mac_address: Option<String>,
}

// ============================================================================
// Storage Information
// ============================================================================

/// Storage capacity and type information.
///
/// Provides information about the primary storage device including
/// total capacity, available space, and storage technology type.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// Total storage capacity in bytes
    pub total_space: u64,
    /// Available (free) storage space in bytes
    pub free_space: u64,
    /// Storage technology type: "Ssd", "Hdd", "Removable", "Unknown"
    pub storage_type: Option<String>,
}

// ============================================================================
// Display Information
// ============================================================================

/// Display/screen properties and capabilities.
///
/// Contains information about the primary display including resolution,
/// scaling factor, and refresh rate.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Screen width in physical pixels
    pub width: u32,
    /// Screen height in physical pixels
    pub height: u32,
    /// Display scale factor (e.g., 2.0 for Retina/HiDPI displays)
    pub scale_factor: f64,
    /// Screen refresh rate in Hz (e.g., 60.0, 120.0, 144.0)
    pub refresh_rate: Option<f64>,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ============ DeviceInfoResponse Tests ============

    #[test]
    fn device_info_response_default_is_all_none() {
        let info = DeviceInfoResponse::default();
        assert!(info.uuid.is_none());
        assert!(info.manufacturer.is_none());
        assert!(info.model.is_none());
        assert!(info.serial.is_none());
        assert!(info.android_id.is_none());
        assert!(info.device_name.is_none());
    }

    #[test]
    fn device_info_response_serializes_correctly() {
        let info = DeviceInfoResponse {
            uuid: Some("test-uuid".to_string()),
            manufacturer: Some("Apple Inc.".to_string()),
            model: Some("MacBook Pro".to_string()),
            serial: Some("ABC123".to_string()),
            android_id: None,
            device_name: Some("My Mac".to_string()),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("test-uuid"));
        assert!(json.contains("Apple Inc."));
        assert!(json.contains("MacBook Pro"));
    }

    #[test]
    fn device_info_response_deserializes_correctly() {
        let json = r#"{
            "uuid": "12345",
            "manufacturer": "Dell",
            "model": "XPS 15",
            "serial": null,
            "android_id": null,
            "device_name": "Work Laptop"
        }"#;

        let info: DeviceInfoResponse = serde_json::from_str(json).unwrap();
        assert_eq!(info.uuid, Some("12345".to_string()));
        assert_eq!(info.manufacturer, Some("Dell".to_string()));
        assert!(info.serial.is_none());
    }

    // ============ BatteryInfo Tests ============

    #[test]
    fn battery_info_default_is_all_none() {
        let battery = BatteryInfo::default();
        assert!(battery.level.is_none());
        assert!(battery.is_charging.is_none());
        assert!(battery.health.is_none());
    }

    #[test]
    fn battery_info_serializes_with_camel_case() {
        let battery = BatteryInfo {
            level: Some(85.0),
            is_charging: Some(true),
            health: Some("Good".to_string()),
        };

        let json = serde_json::to_string(&battery).unwrap();
        // Check camelCase: isCharging not is_charging
        assert!(json.contains("isCharging"));
        assert!(!json.contains("is_charging"));
        assert!(json.contains("85"));
    }

    #[test]
    fn battery_info_deserializes_from_camel_case() {
        let json = r#"{"level": 50.0, "isCharging": false, "health": "Good"}"#;
        let battery: BatteryInfo = serde_json::from_str(json).unwrap();

        assert_eq!(battery.level, Some(50.0));
        assert_eq!(battery.is_charging, Some(false));
    }

    // ============ NetworkInfo Tests ============

    #[test]
    fn network_info_default_is_all_none() {
        let network = NetworkInfo::default();
        assert!(network.ip_address.is_none());
        assert!(network.network_type.is_none());
        assert!(network.mac_address.is_none());
    }

    #[test]
    fn network_info_serializes_with_camel_case() {
        let network = NetworkInfo {
            ip_address: Some("192.168.1.100".to_string()),
            network_type: Some("wifi".to_string()),
            mac_address: Some("AA:BB:CC:DD:EE:FF".to_string()),
        };

        let json = serde_json::to_string(&network).unwrap();
        assert!(json.contains("ipAddress"));
        assert!(json.contains("networkType"));
        assert!(json.contains("macAddress"));
    }

    // ============ StorageInfo Tests ============

    #[test]
    fn storage_info_default_has_zero_values() {
        let storage = StorageInfo::default();
        assert_eq!(storage.total_space, 0);
        assert_eq!(storage.free_space, 0);
        assert!(storage.storage_type.is_none());
    }

    #[test]
    fn storage_info_serializes_with_camel_case() {
        let storage = StorageInfo {
            total_space: 500_000_000_000, // 500GB
            free_space: 100_000_000_000,  // 100GB
            storage_type: Some("Ssd".to_string()),
        };

        let json = serde_json::to_string(&storage).unwrap();
        assert!(json.contains("totalSpace"));
        assert!(json.contains("freeSpace"));
        assert!(json.contains("storageType"));
    }

    // ============ DisplayInfo Tests ============

    #[test]
    fn display_info_default_has_zero_values() {
        let display = DisplayInfo::default();
        assert_eq!(display.width, 0);
        assert_eq!(display.height, 0);
        assert_eq!(display.scale_factor, 0.0);
        assert!(display.refresh_rate.is_none());
    }

    #[test]
    fn display_info_serializes_with_camel_case() {
        let display = DisplayInfo {
            width: 2560,
            height: 1440,
            scale_factor: 2.0,
            refresh_rate: Some(60.0),
        };

        let json = serde_json::to_string(&display).unwrap();
        assert!(json.contains("scaleFactor"));
        assert!(json.contains("refreshRate"));
        assert!(json.contains("2560"));
    }

    #[test]
    fn display_info_deserializes_from_camel_case() {
        let json = r#"{"width": 1920, "height": 1080, "scaleFactor": 1.0, "refreshRate": 144.0}"#;
        let display: DisplayInfo = serde_json::from_str(json).unwrap();

        assert_eq!(display.width, 1920);
        assert_eq!(display.height, 1080);
        assert_eq!(display.refresh_rate, Some(144.0));
    }
}
