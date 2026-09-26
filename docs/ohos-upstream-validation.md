# Official Tauri OpenHarmony migration: validation status

This migration pins `tauri-apps/tauri:feat/open-harmony` at
`e3bf6eb168bacc7bb5c8c32d923bb8beaf77c92b`. The official source and OHOS
template icons are unchanged. **This revision is not yet verified to build or
run Moke on OHOS and should not be merged as a working OHOS migration.**

## Confirmed source incompatibility

The official `crates/tauri-plugin/src/build/mobile.rs` emits `cfg(mobile)` for
`target_env = "ohos"`. Moke's pinned `tauri-plugin-shell` 2.3.5 independently
emits `cfg(desktop)` for every target other than Android and iOS, including
OHOS. Cargo accumulates these flags; one does not cancel the other.

Consequently, the shell plugin enables both `Shell::open` implementations in
`src/lib.rs`. It also initializes `mobile_plugin_handle: handle`, while `handle`
is declared only for Android or iOS. The pinned `tauri-plugin-opener` 2.5.4
similarly uses mobile implementations with Android/iOS-only plugin handles.
These are source-level build blockers, not failures observed in a completed
cross-compilation.

The previous Tauri fork changed the plugin build helper to select the Rust
fallback for OHOS. The official revision does not include that change. A
working migration needs compatible plugins or a narrowly scoped compatibility
fix; changing the submodule URL and passing frontend tests does not resolve it.

## Other runtime checks still required

- OHOS development IPC: the official revision enables `PROXY_DEV_SERVER` for
  all mobile development builds. The removed fork fix excluded OHOS because
  ArkWeb IPC replies could hang when using that proxy. Verify startup and an
  actual native command in development mode.
- Dynamic ACL: the removed fork fix prevented command-scope ID collisions in
  `RuntimeAuthority::add_capability`. Moke calls `add_capability` in debug
  builds. Verify file and HTTP permissions after installing the development
  capability; do not widen permissions to work around errors.
- Test a release HAP separately: launch, persist a server setting across
  restart, connect to Talebook, open an online book, open a downloaded book,
  return to the shelf, and check default launcher icons.

## Available evidence and environment limits

- The locked OHOS dependency graph resolves offline. `cargo tree
  --manifest-path src-tauri/Cargo.toml --locked --offline --target
  aarch64-unknown-linux-ohos -i glib-sys` reports no dependency path, so the
  current vendored Wry already excludes GTK from this target.
- Frontend and contract tests do not compile OHOS plugin code. The ordinary
  frontend CI job now initializes `vendor/tauri`, which the new template-icon
  test requires.
- The local Rust OHOS target is installed, but the OHOS SDK/toolchain is not
  configured and `ohpm` is unavailable. `hdc list targets` reports `[Empty]`.
- PR #15 GitHub Actions jobs did not start: their annotations report an
  account billing/spending-limit restriction. They provide no build evidence.

To complete validation, resolve the plugin incompatibility, provide an OHOS
SDK with `ohpm`/Hvigor, build the HAP using the pinned official CLI, and run the
above checks on an OHOS device or emulator. Preserve the official template
icons; icon customization is outside this migration.
