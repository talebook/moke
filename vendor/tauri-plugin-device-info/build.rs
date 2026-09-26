const COMMANDS: &[&str] = &[
    "get_device_info",
    "get_battery_info",
    "get_network_info",
    "get_storage_info",
    "get_display_info",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
