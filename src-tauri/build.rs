mod build_config;

// Keep this list in lockstep with readestlib::reader_invoke_handler. The
// reader-only contract test parses both lists and fails if the submodule's bare
// command surface drifts. `ext_reader_event` is the one host-owned command: it
// is declared here so dedicated Reader windows can receive an explicit ACL
// grant instead of leaving the Moke extension bridge unmanaged.
const APP_ACL_COMMANDS: &[&str] = &[
    "open_reader",
    "start_server",
    "download_file",
    "upload_file",
    "get_executable_dir",
    "allow_paths_in_scopes",
    "read_dir",
    "parse_epub_metadata",
    "extract_epub_cover_full",
    "parse_epub_full",
    "parse_mobi_metadata",
    "extract_mobi_cover_full",
    "update_book_presence",
    "clear_book_presence",
    "clip_url",
    "localsend_start",
    "localsend_stop",
    "localsend_get_status",
    "localsend_list_devices",
    "localsend_announce",
    "localsend_respond",
    "localsend_cancel_receive",
    "localsend_send_files",
    "localsend_cancel_send",
    // Host command implemented in src/extensions/mod.rs, not readestlib.
    "ext_reader_event",
];

fn main() {
    // Readest's bare app-level commands are linked through a Rust library, so
    // its app ACL manifest cannot propagate like a plugin `links` manifest.
    // Declare that command surface in the embedding host; Reader capabilities
    // can then grant it to both bundled and debug-remote Reader windows.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(APP_ACL_COMMANDS),
    );

    // Desktop capabilities reference plugins that are unavailable on OHOS, so
    // only compile the platform-specific capability. Device dev servers run on
    // ports 3000/3001 and need a remote origin. Only Cargo's explicit
    // development profiles receive that grant; release, custom, and missing
    // profiles fail closed to the production capability.
    let attributes = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("ohos") {
        let profile = std::env::var("PROFILE").ok();
        let capability = build_config::ohos_capability_for_profile(profile.as_deref());
        println!("cargo:rerun-if-changed=capabilities/ohos.json");
        println!("cargo:rerun-if-changed=capabilities-dev/ohos.json");
        attributes.capabilities_path_pattern(capability)
    } else {
        attributes
    };

    tauri_build::try_build(attributes).expect("failed to build Tauri assets");
}
