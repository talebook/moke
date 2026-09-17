//! Preview-only native surface.
//!
//! This module is compiled only with Cargo's `preview` feature. Keep every
//! privileged Preview implementation behind this boundary so stable builds do
//! not merely hide the UI: they omit the native code entirely.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreviewCapability {
    Foundation,
}

/// Fail closed until the online entitlement service is implemented.
///
/// Future Preview commands must call this guard before doing privileged work.
/// Returning an error here prevents the private build scaffold from silently
/// becoming an authorization bypass while the service contract is unfinished.
pub(crate) fn require_preview_capability(
    _capability: PreviewCapability,
) -> Result<(), &'static str> {
    Err("preview entitlement is not configured")
}

#[cfg(test)]
mod tests {
    use super::{require_preview_capability, PreviewCapability};

    #[test]
    fn unfinished_entitlement_guard_fails_closed() {
        assert_eq!(
            require_preview_capability(PreviewCapability::Foundation),
            Err("preview entitlement is not configured"),
        );
    }
}
