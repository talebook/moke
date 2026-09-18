//! Preview-only native surface.
//!
//! This module is compiled only with Cargo's `preview` feature. Keep every
//! privileged Preview implementation behind this boundary so stable builds do
//! not merely hide the UI: they omit the native code entirely.

pub(crate) mod entitlement;

#[allow(unused_imports)]
pub(crate) use entitlement::{require_preview_capability, PreviewCapability};
