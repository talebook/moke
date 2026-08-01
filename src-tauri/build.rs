fn main() {
    // The desktop capability file references the reader's desktop-only
    // plugins. Tauri scans every matching capability file at build time, so
    // point OHOS builds at the deliberately small, mobile-safe capability
    // file instead of merely selecting it in tauri.ohos.conf.json.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("ohos") {
        println!("cargo:rerun-if-changed=capabilities/ohos.json");
        tauri_build::try_build(
            tauri_build::Attributes::new().capabilities_path_pattern("capabilities/ohos.json"),
        )
        .expect("failed to build OpenHarmony Tauri assets");
    } else {
        tauri_build::build();
    }
}
