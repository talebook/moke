pub(crate) const OHOS_PRODUCTION_CAPABILITY: &str = "capabilities/ohos.json";
pub(crate) const OHOS_DEVELOPMENT_CAPABILITY: &str = "capabilities-dev/ohos.json";
pub(crate) const OHOS_DEVELOPMENT_PROFILES: &[&str] = &["debug", "dev"];

pub(crate) fn ohos_capability_for_profile(profile: Option<&str>) -> &'static str {
    match profile {
        Some(profile) if OHOS_DEVELOPMENT_PROFILES.contains(&profile) => {
            OHOS_DEVELOPMENT_CAPABILITY
        }
        _ => OHOS_PRODUCTION_CAPABILITY,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ohos_capability_for_profile, OHOS_DEVELOPMENT_CAPABILITY, OHOS_PRODUCTION_CAPABILITY,
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
}
