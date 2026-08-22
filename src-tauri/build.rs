fn main() {
    // Desktop capabilities reference plugins that are unavailable on OHOS, so
    // only compile the platform-specific capability. Device dev servers run on
    // ports 3000/3001 and need a remote origin, but release builds must never
    // include that grant.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("ohos") {
        let capability = if std::env::var("PROFILE").as_deref() == Ok("release") {
            "capabilities/ohos.json"
        } else {
            "capabilities-dev/ohos.json"
        };
        println!("cargo:rerun-if-changed=capabilities/ohos.json");
        println!("cargo:rerun-if-changed=capabilities-dev/ohos.json");
        tauri_build::try_build(
            tauri_build::Attributes::new().capabilities_path_pattern(capability),
        )
        .expect("failed to build OpenHarmony Tauri assets");
    } else {
        tauri_build::build();
    }
}
