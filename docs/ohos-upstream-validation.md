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

`[patch.crates-io]` applies to **every target**, including Windows, macOS and
Linux. Desktop builds also adopt the filesystem upgrade from 2.5.1 to 2.7.1,
shell from 2.3.5 to 2.3.6, opener from 2.5.4 to 2.5.5, and all seven local
Reader plugin copies below. These are not dependencies selected only on OHOS.

Seven locked Reader plugin versions are copied under `vendor/tauri-plugin-*`.
Their Rust patches explicitly select OHOS fallbacks: device-info returns empty information; log uses Rust streams;
deep-link returns no cold-start link; unsupported sign-in, sharing, haptics and
biometric operations use their existing error/no-op backends. Source comparison
found no intended change to other platforms in these seven Rust patches; this
does not prove runtime equivalence on those platforms. No device credential or
authorization backend is part of this promotion.

## Exact plugin provenance and allowed differences

`docs/vendor-plugin-provenance.json` records the published version, crates.io
archive URL/checksum, original VCS commit and directory, complete archive file
inventory, complete local file inventory, and raw SHA-256 for every file. All ten
official archives were downloaded and their checksums matched the crates.io
registry index/API before recording these comparisons. The seven copies are
biometric 2.3.2, device-info 1.0.1, log 2.9.0, haptics 2.3.2, sharekit 0.3.1,
sign-in-with-apple 1.0.2 and deep-link 2.4.9.

The manifest records every modification, addition and omission individually.
`deltaSha256` identifies the exact sorted list of `[path, upstream hash or
null, local hash or null]` rows, serialized with `JSON.stringify`. An allowed
file is therefore not permission for arbitrary future edits to that file.

The seven local copies contain nine changed/added Rust files. Other recorded
differences are the generated schemas adding `openHarmony` to the platform
enum, a generated default-permission-reference heading, and formatting of the
deep-link JavaScript bundle. Seven Swift/Kotlin files had trailing space/tab
removed; only those explicit paths use normalization when comparing their
published contents. **Local integrity hashes always use raw bytes**, including
whitespace. Omitted package files are individually listed, including registry
metadata, original manifests/lockfiles, publishing sources/tooling, documentation
and the sign-in package's accidentally published Gradle caches.

The three submodule plugins are compared against their actual published
versions, not only against the older Moke pins:

| Plugin | Compared published version | Differences requiring review |
| --- | --- | --- |
| filesystem | 2.7.1 | Two Rust files select sandbox I/O and existing path/scope checks on OHOS; repository Cargo metadata uses workspace inheritance. All targets also receive upstream changes since 2.5.1. |
| shell | 2.3.6 | OHOS backend selection and async dispatch, plus a shared `open_unchecked` helper and `OpenScope: Clone`; desktop reaches the existing `open` crate branch through the helper. |
| opener | 2.5.5 | OHOS backend/transport and explicit unsupported operations; shared command code finishes allow/deny evaluation before dispatch, changing its scope lifetime on every target. |

Their full local trees and exact differences are hashed too. The checker also
requires both the checked-out and indexed `vendor/ohos-plugins` gitlink to be
`abade34813aff19d15ee2529be7f5607deff9388`. Workspace manifest differences,
generated/formatting differences and repository-only files are declared
separately; they are not hidden behind a blanket OHOS-cfg exception.

Run the default offline integrity check after initializing submodules:

```bash
node scripts/check-vendor-plugin-provenance.mjs
node --test tests/ohos-plugin-compat.test.mjs
```

The default mode only checks the checked-in declaration and local files for
drift; it does not independently revalidate their registry origin. It checks
all root vendor-plugin patches, exact Cargo versions, local file
inventories/hashes, the difference allowlist/digest and the submodule pin. The
tests also inject a desktop code change, an added file and a removed file into
a temporary copy and require rejection. They never edit the real vendor tree.

For independently reproducible upstream comparison, fetch the pinned public
archives, verify their package checksums and full original inventories, and
check the seven declared whitespace-only changes:

```bash
node scripts/check-vendor-plugin-provenance.mjs --verify-registry
```

This optional mode needs network access to `static.crates.io` and `tar`; the
default mode needs neither. It fails if an archive or any reviewed original
file differs. Future plugin changes require reviewing the upstream source and
updating the explicit provenance in the same PR; there is no automatic
allowlist regeneration or test bypass.

Provenance describes the checked-out source files. Run it before native builds:
Tauri tooling can regenerate schemas inside plugin source trees, and those
changes are reported too. Generated output must be restored or reviewed as an
intentional tooling change; it must not automatically refresh the allowlist.

These checks constrain source drift; they do not establish platform behavior.
The complete Rust compile/test gates and desktop/mobile platform validation
remain necessary for the all-target dependency updates.

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
