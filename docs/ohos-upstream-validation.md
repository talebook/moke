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

The official `tauri-apps/plugins-workspace:feat/open-harmony` branch was also
checked at `cc9ec9b4ad2f9ec9bd57c3503ded1bd94d092c48`. Its shell `build.rs`
still considers only Android/iOS mobile, and both shell/opener initialize their
mobile handles only for those two platforms. Switching to that branch alone
therefore does not resolve the conflict with Tauri's OHOS mobile flag.

## Official CLI build

The default locked CLI build was attempted on the Linux ARM64 host and failed
with E0277 in `rustls-platform-verifier` 0.3.4: `webpki::Error` does not implement
`std::error::Error`. The dispatcher and release workflow now select upstream's
`--no-default-features --features rustls` configuration. This uses bundled CA
roots instead of `platform-certs`; certificate verification is still enabled,
but custom system CA roots are not loaded. No official Tauri source or lockfile
is patched for this configuration.

The CLI subsequently built successfully: both `ohos dev --help` and
`pnpm tauri ohos init --ci --skip-targets-install` completed. This is CLI and
project-generation evidence, not a completed Moke HAP build.

## Local host preparation (2026-09-26)

- Installed/extracted the CI SDK distribution `ErBWs/ohos-sdk` 6.1.1.280.
  The concatenated archive SHA-256 matched
  `3d37eb5a3a81358a9731c35265f4f29d8ecf1028b0bbbb777f2928cd6990aa83`.
  Host Node 24 is used instead of the SDK's bundled x64 Node.
- On this ARM64, 16-KiB-page host, the x64 SDK linker could not map its
  `libxml2.so.16`. Host-local adapters use installed native Clang/LLVM 19 and
  libclang with the official SDK headers, sysroot and Clang 15 runtime resources.
  Original SDK x64 tools are retained beside the adapters. A C shared-library
  smoke test produced an AArch64 ELF using the SDK sysroot. Tauri source is unchanged.
- Generated `src-tauri/gen/ohos`, installed `@ohos-rs/ability` 0.4.0-beta.0,
  and verified `hvigorw --no-daemon tasks` and `--sync`. Adjusted the generated
  Hvigor hook's CLI path to resolve from the project instead of a wrong relative
  working directory; template icons remain unchanged.
- Prepared Reader dependencies and PDF.js, SimpleCC and Jieba generated assets.
- HDC reconnect plus an API query succeeds against QEMU API 26. The native
  host HDC is used by the local SDK adapter as well.
- A dev invocation reached `ohrs build --arch arm64` and Rust compilation. This
  check disabled frontend startup and did not attach to QEMU (the independently
  tested HDC connection had to be re-established). Compilation was deliberately
  stopped; no current HAP was installed and no UI/IPC success is claimed.
- Per developer direction, shell/opener compatibility is deferred, not fixed.
  Re-downloadable package/archive caches and old generated Rust caches were
  removed; roughly 25 GiB was available afterwards. Code, QEMU disks and app
  data were preserved. The older frontend service was stopped to free ports
  3000/3001 for the current checkout.

Host-local `../ohos-env.sh` loads the toolchain environment. From the Moke
checkout, `bash ../ohos-dev.sh --no-watch` also reconnects HDC and invokes
`pnpm tauri ohos dev --host 10.0.2.2`. These host-specific files and generated
SDK/project files are not portable repository configuration. Signing and a
complete HAP/runtime test still remain after resolving native compatibility.

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
- The local Rust OHOS target and SDK/toolchain are now configured as described
  above; initial attempts had no SDK or `ohpm` available.
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
- Early dispatcher build attempts were interrupted. The subsequent Rustls-only
  CLI build and help command succeeded; the full Moke dev build remains
  incomplete. The old installed app has not been uninstalled.
- Previous local build logs identify an SDK under the earlier validation
  task's `ohos-run/sdk/command-line-tools` directory, but that directory is
  no longer present. Initially no replacement SDK archive was found in the
  inspected caches; a fresh verified SDK has since been installed as above.
- PR #15 GitHub Actions jobs did not start: their annotations report an
  account billing/spending-limit restriction. They provide no build evidence.

To complete validation, resolve the plugin incompatibility, configure signing,
build the HAP using the pinned official CLI, and run the
above checks on the recovered QEMU or an OHOS device. Preserve the official template
icons; icon customization is outside this migration.
