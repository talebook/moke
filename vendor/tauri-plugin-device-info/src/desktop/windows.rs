use crate::models::DeviceInfoResponse;
use serde::Deserialize;
use wmi::{COMLibrary, WMIConnection};

#[derive(Deserialize, Debug)]
struct Win32ComputerSystem {
    #[serde(rename = "Manufacturer")]
    manufacturer: Option<String>,
    #[serde(rename = "Model")]
    model: Option<String>,
    #[serde(rename = "Name")]
    name: Option<String>, // hostname
}

#[derive(Deserialize, Debug)]
struct Win32ComputerSystemProduct {
    #[serde(rename = "UUID")]
    uuid: Option<String>,
    #[serde(rename = "IdentifyingNumber")]
    identifying_number: Option<String>, // bazen serial burada olur
}

#[derive(Deserialize, Debug)]
struct Win32BIOS {
    #[serde(rename = "SerialNumber")]
    serial: Option<String>,
}

pub fn get_device_info() -> crate::Result<DeviceInfoResponse> {
    let result = (|| -> Option<DeviceInfoResponse> {
        let com_lib = COMLibrary::new().ok()?;
        let wmi_connection = WMIConnection::new(com_lib).ok()?;

        let computer_systems: Vec<Win32ComputerSystem> = wmi_connection
            .raw_query("SELECT Manufacturer, Model, Name FROM Win32_ComputerSystem")
            .ok()?;
        let system_products: Vec<Win32ComputerSystemProduct> = wmi_connection
            .raw_query("SELECT UUID, IdentifyingNumber FROM Win32_ComputerSystemProduct")
            .ok()?;
        let bios_data: Vec<Win32BIOS> = wmi_connection
            .raw_query("SELECT SerialNumber FROM Win32_BIOS")
            .ok()?;

        let system_info = computer_systems.first();
        let product_info = system_products.first();
        let bios_info = bios_data.first();

        Some(DeviceInfoResponse {
            device_name: system_info.and_then(|s| s.name.clone()),
            manufacturer: system_info.and_then(|s| s.manufacturer.clone()),
            model: system_info.and_then(|s| s.model.clone()),
            uuid: product_info.and_then(|p| p.uuid.clone()),
            // serial tercihen BIOS, yoksa Product IdentifyingNumber
            serial: bios_info
                .and_then(|b| b.serial.clone())
                .or_else(|| product_info.and_then(|p| p.identifying_number.clone())),
            android_id: None,
        })
    })();

    Ok(result.unwrap_or(DeviceInfoResponse {
        device_name: None,
        manufacturer: None,
        model: None,
        uuid: None,
        serial: None,
        android_id: None,
    }))
}

#[derive(Deserialize, Debug)]
struct Win32VideoController {
    #[serde(rename = "CurrentRefreshRate")]
    current_refresh_rate: Option<u32>,
}

pub fn get_display_refresh_rate() -> Option<f64> {
    let com_lib = COMLibrary::new().ok()?;
    let wmi_connection = WMIConnection::new(com_lib).ok()?;

    let results: Vec<Win32VideoController> = wmi_connection
        .raw_query("SELECT CurrentRefreshRate FROM Win32_VideoController")
        .ok()?;

    // Return the refresh rate of the first active controller found
    results
        .iter()
        .find_map(|r| r.current_refresh_rate.map(|rate| rate as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_computer_system_deserializes_correctly() {
        let json = r#"{
            "Manufacturer": "Dell Inc.",
            "Model": "OptiPlex 7090",
            "Name": "DESKTOP-ABC123"
        }"#;

        let system: Win32ComputerSystem = serde_json::from_str(json).unwrap();
        assert_eq!(system.manufacturer, Some("Dell Inc.".to_string()));
        assert_eq!(system.model, Some("OptiPlex 7090".to_string()));
        assert_eq!(system.name, Some("DESKTOP-ABC123".to_string()));
    }

    #[test]
    fn win32_computer_system_handles_null_fields() {
        let json = r#"{
            "Manufacturer": null,
            "Model": "Test Model",
            "Name": null
        }"#;

        let system: Win32ComputerSystem = serde_json::from_str(json).unwrap();
        assert!(system.manufacturer.is_none());
        assert_eq!(system.model, Some("Test Model".to_string()));
        assert!(system.name.is_none());
    }

    #[test]
    fn win32_computer_system_product_deserializes_correctly() {
        let json = r#"{
            "UUID": "12345678-1234-5678-9ABC-DEF012345678",
            "IdentifyingNumber": "ABC123"
        }"#;

        let product: Win32ComputerSystemProduct = serde_json::from_str(json).unwrap();
        assert_eq!(
            product.uuid,
            Some("12345678-1234-5678-9ABC-DEF012345678".to_string())
        );
        assert_eq!(product.identifying_number, Some("ABC123".to_string()));
    }

    #[test]
    fn win32_bios_deserializes_correctly() {
        let json = r#"{"SerialNumber": "XYZ789"}"#;

        let bios: Win32BIOS = serde_json::from_str(json).unwrap();
        assert_eq!(bios.serial, Some("XYZ789".to_string()));
    }

    #[test]
    fn serial_fallback_logic_prefers_bios() {
        // Simulate the fallback logic
        let bios_serial: Option<String> = Some("BIOS-SERIAL".to_string());
        let product_id: Option<String> = Some("PRODUCT-ID".to_string());

        let serial = bios_serial.clone().or_else(|| product_id.clone());
        assert_eq!(serial, Some("BIOS-SERIAL".to_string()));
    }

    #[test]
    fn serial_fallback_logic_uses_product_when_bios_missing() {
        let bios_serial: Option<String> = None;
        let product_id: Option<String> = Some("PRODUCT-ID".to_string());

        let serial = bios_serial.or_else(|| product_id);
        assert_eq!(serial, Some("PRODUCT-ID".to_string()));
    }

    #[test]
    fn win32_video_controller_deserializes_correctly() {
        let json = r#"{"CurrentRefreshRate": 144}"#;

        let controller: Win32VideoController = serde_json::from_str(json).unwrap();
        assert_eq!(controller.current_refresh_rate, Some(144));
    }

    #[test]
    fn refresh_rate_converts_to_f64() {
        let rate: u32 = 60;
        let rate_f64 = rate as f64;
        assert!((rate_f64 - 60.0).abs() < 0.001);
    }

    #[test]
    fn fallback_response_has_all_none_fields() {
        let fallback = DeviceInfoResponse {
            device_name: None,
            manufacturer: None,
            model: None,
            uuid: None,
            serial: None,
            android_id: None,
        };

        assert!(fallback.device_name.is_none());
        assert!(fallback.manufacturer.is_none());
        assert!(fallback.uuid.is_none());
    }
}
