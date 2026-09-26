use crate::models::DeviceInfoResponse;
use std::fs;

fn read(path: &str) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

pub fn get_device_info() -> crate::Result<DeviceInfoResponse> {
    // hostname (native dosyalardan)
    let device_name = read("/proc/sys/kernel/hostname").or_else(|| read("/etc/hostname"));

    Ok(DeviceInfoResponse {
        device_name,
        manufacturer: read("/sys/class/dmi/id/sys_vendor"),
        model: read("/sys/class/dmi/id/product_name"),
        uuid: read("/sys/class/dmi/id/product_uuid").or_else(|| read("/etc/machine-id")), // fallback
        serial: read("/sys/class/dmi/id/product_serial"),
        android_id: None,
    })
}

pub fn get_display_refresh_rate() -> Option<f64> {
    use std::process::Command;

    // Try using xrandr, standard on X11
    let output = Command::new("xrandr")
        .args(["--current"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok());

    if let Some(out) = output {
        // Output format example line:
        // "   1920x1080     60.00*+  59.96    59.93"
        // The asterisk (*) marks the current mode
        for line in out.lines() {
            if line.contains('*') {
                // Split by whitespace and find the part with '*'
                if let Some(part) = line.split_whitespace().find(|s| s.contains('*')) {
                    let clean = part.replace("*", "").replace("+", "");
                    return clean.parse::<f64>().ok();
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_returns_none_for_nonexistent_file() {
        let result = read("/nonexistent/path/to/file");
        assert!(result.is_none());
    }

    #[test]
    fn read_trims_whitespace() {
        // Create a temp file with whitespace
        use std::io::Write;
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_read_trim.txt");

        {
            let mut file = std::fs::File::create(&temp_file).unwrap();
            writeln!(file, "  test value  ").unwrap();
        }

        let result = read(temp_file.to_str().unwrap());
        assert_eq!(result, Some("test value".to_string()));

        // Cleanup
        let _ = std::fs::remove_file(temp_file);
    }

    #[test]
    fn parse_xrandr_refresh_rate() {
        // Simulated xrandr output line
        let xrandr_line = "   1920x1080     60.00*+  59.96    59.93";

        // Extract refresh rate like our function does
        if let Some(part) = xrandr_line.split_whitespace().find(|s| s.contains('*')) {
            let clean = part.replace("*", "").replace("+", "");
            let rate: f64 = clean.parse().unwrap();
            assert!((rate - 60.0).abs() < 0.01);
        } else {
            panic!("Failed to find refresh rate in xrandr line");
        }
    }

    #[test]
    fn parse_xrandr_without_plus() {
        // Some systems show just asterisk without plus
        let xrandr_line = "   2560x1440     144.00*  120.00    60.00";

        if let Some(part) = xrandr_line.split_whitespace().find(|s| s.contains('*')) {
            let clean = part.replace("*", "").replace("+", "");
            let rate: f64 = clean.parse().unwrap();
            assert!((rate - 144.0).abs() < 0.01);
        } else {
            panic!("Failed to find refresh rate");
        }
    }
}
