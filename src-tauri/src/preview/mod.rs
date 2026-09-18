//! Preview-only native surface.
//!
//! This module is compiled only with Cargo's `preview` feature. Keep every
//! privileged Preview implementation behind this boundary so stable builds do
//! not merely hide the UI: they omit the native code entirely.

pub(crate) mod entitlement;

#[allow(unused_imports)]
pub(crate) use entitlement::{require_preview_capability, PreviewCapability};

const UNAUTHENTICATED_COMMANDS: &[&str] = &[
    "moke_build_info",
    "moke_preview_activate",
    "moke_preview_entitlement_status",
];

pub(crate) fn command_requires_entitlement(command: &str) -> bool {
    !UNAUTHENTICATED_COMMANDS.contains(&command)
}

pub(crate) fn authorize_command(app: &tauri::AppHandle, command: &str) -> Result<(), String> {
    if command_requires_entitlement(command) {
        require_preview_capability(app, PreviewCapability::Foundation)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::command_requires_entitlement;

    #[test]
    fn only_preview_bootstrap_commands_bypass_the_native_gate() {
        for command in [
            "moke_build_info",
            "moke_preview_activate",
            "moke_preview_entitlement_status",
        ] {
            assert!(!command_requires_entitlement(command), "{command}");
        }

        for command in [
            "moke_preview_refresh",
            "moke_runtime_platform",
            "moke_list_downloaded_books",
            "open_reader",
            "ext_enable_extension",
            "moke_preview_activate_suffix",
        ] {
            assert!(command_requires_entitlement(command), "{command}");
        }
    }
}
