use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BuildChannel {
    Stable,
    Preview,
}

impl BuildChannel {
    pub(crate) const fn current() -> Self {
        if cfg!(feature = "preview") {
            Self::Preview
        } else {
            Self::Stable
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MokeBuildInfo {
    channel: BuildChannel,
    preview_compiled: bool,
}

impl MokeBuildInfo {
    pub(crate) const fn current() -> Self {
        let channel = BuildChannel::current();
        Self {
            channel,
            preview_compiled: matches!(channel, BuildChannel::Preview),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BuildChannel, MokeBuildInfo};

    #[test]
    fn build_channel_matches_the_compile_time_feature() {
        let expected = if cfg!(feature = "preview") {
            BuildChannel::Preview
        } else {
            BuildChannel::Stable
        };
        let info = MokeBuildInfo::current();

        assert_eq!(BuildChannel::current(), expected);
        assert_eq!(info.channel, expected);
        assert_eq!(info.preview_compiled, cfg!(feature = "preview"));
    }
}
