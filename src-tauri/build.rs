mod build_config;

fn main() {
    // Desktop capabilities reference plugins that are unavailable on OHOS, so
    // only compile the platform-specific capability. Device dev servers run on
    // ports 3000/3001 and need a remote origin. Only Cargo's explicit
    // development profiles receive that grant; release, custom, and missing
    // profiles fail closed to the production capability.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("ohos") {
        let profile = std::env::var("PROFILE").ok();
        let capability = build_config::ohos_capability_for_profile(profile.as_deref());
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
