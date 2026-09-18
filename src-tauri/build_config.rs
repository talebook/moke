pub(crate) const OHOS_PRODUCTION_CAPABILITY: &str = "capabilities/ohos.json";
pub(crate) const OHOS_DEVELOPMENT_CAPABILITY: &str = "capabilities-dev/ohos.json";
pub(crate) const OHOS_DEVELOPMENT_PROFILES: &[&str] = &["debug", "dev"];
pub(crate) const PREVIEW_IDENTIFIER: &str = "org.houheya.moke.preview";

fn builds_preview_frontend(command: &str) -> bool {
    matches!(
        command.split("&&").next().map(str::trim),
        Some("pnpm build:preview" | "pnpm run build:preview")
    )
}

pub(crate) fn ohos_capability_for_profile(profile: Option<&str>) -> &'static str {
    match profile {
        Some(profile) if OHOS_DEVELOPMENT_PROFILES.contains(&profile) => {
            OHOS_DEVELOPMENT_CAPABILITY
        }
        _ => OHOS_PRODUCTION_CAPABILITY,
    }
}

pub(crate) fn validate_preview_build_channel(
    profile: Option<&str>,
    preview_feature: bool,
    tauri_config: Option<&str>,
) -> Result<(), String> {
    if profile != Some("release") && tauri_config.is_none() {
        return Ok(());
    }

    let config = tauri_config
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()
        .map_err(|error| format!("TAURI_CONFIG is invalid JSON: {error}"))?;
    let identifier = config
        .as_ref()
        .and_then(|value| value.get("identifier"))
        .and_then(serde_json::Value::as_str);
    let before_build = config
        .as_ref()
        .and_then(|value| value.pointer("/build/beforeBuildCommand"))
        .and_then(serde_json::Value::as_str);
    let preview_config = identifier == Some(PREVIEW_IDENTIFIER);
    let preview_frontend = before_build.is_some_and(builds_preview_frontend);

    if preview_feature != preview_config || preview_feature != preview_frontend {
        return Err(format!(
            "Preview build channel mismatch: feature={preview_feature}, identifier={identifier:?}, beforeBuildCommand={before_build:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ohos_capability_for_profile, validate_preview_build_channel, OHOS_DEVELOPMENT_CAPABILITY,
        OHOS_PRODUCTION_CAPABILITY,
    };

    #[test]
    fn explicit_development_profiles_use_remote_capability() {
        for profile in ["debug", "dev"] {
            assert_eq!(
                ohos_capability_for_profile(Some(profile)),
                OHOS_DEVELOPMENT_CAPABILITY
            );
        }
    }

    #[test]
    fn release_custom_and_missing_profiles_use_local_only_capability() {
        for profile in [
            None,
            Some("release"),
            Some("staging"),
            Some("nightly"),
            Some(""),
        ] {
            assert_eq!(
                ohos_capability_for_profile(profile),
                OHOS_PRODUCTION_CAPABILITY
            );
        }
    }

    #[test]
    fn release_preview_channel_requires_feature_identity_and_frontend_to_match() {
        let preview = r#"{
            "identifier":"org.houheya.moke.preview",
            "build":{"beforeBuildCommand":"pnpm build:preview"}
        }"#;
        let stable = r#"{
            "identifier":"org.houheya.moke",
            "build":{"beforeBuildCommand":"pnpm build"}
        }"#;

        assert!(validate_preview_build_channel(Some("release"), true, Some(preview)).is_ok());
        assert!(validate_preview_build_channel(Some("release"), false, Some(stable)).is_ok());
        assert!(validate_preview_build_channel(Some("release"), true, Some(stable)).is_err());
        assert!(validate_preview_build_channel(Some("release"), false, Some(preview)).is_err());
        assert!(validate_preview_build_channel(Some("release"), true, None).is_err());

        let disguised_stable = r#"{
            "identifier":"org.houheya.moke.preview",
            "build":{"beforeBuildCommand":"pnpm build && echo build:preview"}
        }"#;
        assert!(
            validate_preview_build_channel(Some("release"), true, Some(disguised_stable)).is_err()
        );
    }

    #[test]
    fn direct_debug_cargo_tests_do_not_require_a_tauri_cli_overlay() {
        assert!(validate_preview_build_channel(Some("debug"), true, None).is_ok());
    }
}
