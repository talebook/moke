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
  configured and `ohpm` is unavailable.
- An existing ARM64 QEMU is managed by `ohos-qemu.service`. Its HDC port is
  `127.0.0.1:5555`. The guest was unresponsive; restarting that service restored
  HDC access without replacing its disk images. Explicitly run
  `hdc tconn 127.0.0.1:5555` before selecting that target.
- The recovered guest reports `OpenHarmony-7.0.0.39`, API 26. Its previously
  installed `org.houheya.moke` (package version `1.0.0`, target API 24) accepts
  `aa start -a EntryAbility -b org.houheya.moke` and has a running process, but
  its framebuffer shows a white content area. This older development package
  depends on its matching development server. Launching it separately is not
  a valid failure test for this migration, and it is not built from this PR.
- Initially `pnpm tauri ohos dev --help` failed with `unrecognized subcommand
  'ohos'`: the npm CLI does not ship OHOS support. `scripts/tauri.mjs` now routes
  OHOS commands to the pinned official source CLI through Cargo; other
  commands retain the npm CLI. This fixes command routing, not the native
  plugin incompatibilities described above.
- Retrying the help command through that dispatcher entered the official CLI
  dependency build. It was interrupted before completion because the SDK
  prerequisite was still missing; neither the CLI help nor an OHOS dev build
  completed. The old installed app has not been uninstalled.
- Previous local build logs identify an SDK under the earlier validation
  task's `ohos-run/sdk/command-line-tools` directory, but that directory is
  no longer present. No replacement SDK archive was found in the inspected
  download/cache locations.
- PR #15 GitHub Actions jobs did not start: their annotations report an
  account billing/spending-limit restriction. They provide no build evidence.

To complete validation, resolve the plugin incompatibility, provide an OHOS
SDK with `ohpm`/Hvigor, build the HAP using the pinned official CLI, and run the
above checks on the recovered QEMU or an OHOS device. Preserve the official template
icons; icon customization is outside this migration.
