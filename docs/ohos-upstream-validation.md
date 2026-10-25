# OpenHarmony stable migration validation

This promotion extracts the generally useful OHOS changes from the personal
Moke fork. It preserves the stable application identifier `org.houheya.moke`
and the identity regression from talebook/moke #141. The CLI wrapper does not
modify Tauri's bundle identifier validator.

## Reviewed native dependencies

| Dependency | Pin | Purpose |
| --- | --- | --- |
| `vendor/tauri` | `f8462993daf43e5c4b854df5949df2bce04c89d6` | Official OHOS base plus app name/icon, immersive safe areas, HAP version sync and development ACL scope fixes |
| `vendor/wry` | `6aaf4b84b6e420015c6a14f264f1c7399f150392` | Official `tauri-apps/wry:feat/open-harmony` backend |
| `vendor/ohos-plugins` | `abade34813aff19d15ee2529be7f5607deff9388` | Filesystem sandbox adapter plus scoped shell/opener transport |

The Tauri fork is `hehetoshang/tauri:app-name-fix`. Its general fixes correspond
to upstream PRs [#16151](https://github.com/tauri-apps/tauri/pull/16151),
[#16161](https://github.com/tauri-apps/tauri/pull/16161) and
[#16217](https://github.com/tauri-apps/tauri/pull/16217). The fold-state branch
[#16185](https://github.com/tauri-apps/tauri/pull/16185) is not included.

The root Cargo patches resolve the host and Reader to the same filesystem,
shell and opener crates (2.7.1, 2.3.6 and 2.5.5 respectively). The HTTP Rust
plugin remains at 2.5.9 because the newer plugin requires a newer Tauri/Wry
combination than the experimental OHOS branch.

Seven locked Reader plugin versions are copied under `vendor/tauri-plugin-*`.
The copies keep Android, iOS and desktop behavior, and explicitly select OHOS
fallbacks: device-info returns empty information; log uses Rust streams;
deep-link returns no cold-start link; unsupported sign-in, sharing, haptics and
biometric operations use their existing error/no-op backends. No device
credential or authorization backend is part of this promotion.

## Preparation and runtime boundaries

`pnpm tauri ohos ...` routes to the source CLI. Other platforms still use the
npm CLI. The source CLI selects `--locked --no-default-features --features
rustls`, retaining certificate verification with bundled roots; custom system
CA roots are not loaded by this TLS option.

After OHOS initialization and `ohpm install`:

```bash
node scripts/prepare-mobile-icons.mjs ohos
node scripts/prepare-ohos.mjs
node scripts/prepare-ohos-release.mjs
```

Preparation installs the app-owned UIAbility opener before RustAbility starts
Tauri. This sets the XDG data/config/cache roots to the application sandbox,
then registers asynchronous native URL/file opening. Existing plugin ACL and
scope checks run before transport; no WebView IPC command bypass is introduced.
The downloaded-book command waits through `spawn_blocking` to avoid blocking
the OHOS UI thread. Expired requests are ignored and file Wants grant read
access only. The adapter is removed when EntryAbility is destroyed.

The Windows preparation step repairs the generated Hvigor CLI executable path.
The release preparation step forwards Hvigor's external `buildMode` parameter
to the nested Rust command, adding `--release` only for a release HAP and
upgrading the older incorrect properties-based patch. Unknown or partially
patched hooks fail instead of silently packaging a Debug Rust library.
The normal `prepare-ohos.mjs` dev/build path also applies this profile patch,
so local HAP builds receive the same correction. Mobile icons are committed
resources copied without runtime resizing.

## Validation limits

The Node regression tests execute the real pinned EntryAbility and Hvigor hook
with mocked native APIs. They cover lifecycle ordering, URL/file dispatch,
completion/errors, stale requests, sandbox initialization, profile forwarding,
repeatable preparation and resource copying. They do not establish ArkTS SDK
compatibility, HAP assembly, installation or device behavior.

The source fork recorded a successful OHOS native check and native library
build for an earlier pin. That historical result is not acceptance evidence
for this stable promotion or the newer combined Tauri pin. Current local
checks and any unavailable native checks are reported in the promotion PR.

Device acceptance still needs: development startup and a native IPC call;
release startup; persistence across restart; online/downloaded book opening;
return to the shelf; system external links; launcher/startup icon clarity;
safe-area behavior; and confirmation that a release HAP contains optimized
Rust code. Signing, private distribution and activation are outside this change.

## Source attribution

This is a manual stable extraction of Moke #15 (`dbde2e8`), including
`39e4e40`, `f553a10`, `0b835e3`, `b67ecd1`, `3a1eb98` and `aa7cb02`,
plus icon fixes `bf3d8f8` / `4e7690d`, startup background `7c73cef`,
Hvigor profile fixes `9895288` / `5bbe334`, Tauri pin `55fe8d6`, filesystem
upgrade `f8c2484` and system-link support `a39ab60`. Fork-specific identities,
activation, signing configuration and private distribution code are excluded.
