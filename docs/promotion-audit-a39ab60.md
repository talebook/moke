# Stable maintenance promotion through a39ab60

This promotion starts at `talebook/moke:main` commit `05f5d145096b6fa1c015a87333d71ae89e5e1a44`
and selects the four maintenance groups requested by the developer from
`hehetoshang/moke:main` commit `a39ab6063249fa855c0a914973aabfc6a869634c`.
Changes are manually extracted and adapted to the stable single-server architecture.
This is a follow-up to the selective promotion in PR #140 and preserves its PR #141 fixes.

## Selected sources

| Sources | Stable change |
| --- | --- |
| `915c82f` (#16) | Session-isolated cover cache, request deduplication, bounded loading, current-user probe deduplication, field subscriptions, memoized book rows, single responsive table DOM, batched IndexedDB transactions, serialized book mutations, progress throttling and reduced background work. |
| `67376c0` (#35) | Remove the host's duplicate PDF.js assets and alias; Reader remains their sole owner. |
| `0ae18f6` (#27) | Restore tablet/desktop search header layout while preserving a separate mobile search row. |
| `7c73cef` (#25) | Extract document first-paint background, appearance initialization, native window background and safe-area-independent startup spinner. |
| `81f4c5a`, `1ffefe5` (#34) | Chrome 96 viewport fallbacks, short-screen dropdown placement and tag-picker keyboard focus handling. |
| `dbde2e8` (#15), including `39e4e40`, `f553a10`, `0b835e3`, `b67ecd1`, `3a1eb98`, `aa7cb02` | OHOS sandbox initialization, CLI routing and Windows Hvigor path correction, fs/shell/opener adapters and explicitly unsupported fallbacks for Reader plugins without OHOS backends. |
| `bf3d8f8`, `4e7690d` (#21/#30) | Reviewed platform icon resources and deterministic Android/OHOS resource copying. |
| `9895288`, `5bbe334` (#31/#32) | Forward Hvigor's external buildMode into the Rust build, including correction of the earlier properties-based patch. |
| `55fe8d6`, `f8c2484` | Pinned OHOS Tauri fixes and aligned fs 2.7.1 Rust/JS packages. |
| `410d2c5` | Declare all extension commands in the generated app ACL and grant desktop management commands to the main window. |
| `8510fb4`, `64125b7`, `b4dcc67` | Backport upstream JS HTTP 2.8.3's cancellation fix to matched JS/Rust HTTP 2.5.9 using pnpm patches. Intermediate revert/debug-log suppression commits are not replayed. |
| `4caa8ae`, `a39ab60` | Version-tap debug-button toggle and system-browser external links. Extract the associated runtime panel state and accessibility handling without the server-management UI. |

The debug panel also needs the narrower equivalent of `a2f4edb`'s overlay guard:
native navigation and overlays share one ownership stack, registered during layout effects.
Window-targeted events can
reach the earlier route listener before a later overlay listener, including when the overlay
subsequently consumes the event. Browser regressions reproduce the resulting background navigation
and verify both cancelable and noncancelable back events. Unused predictive-event listeners
are removed; gesture/transition features are excluded.

Performance isolation adds an in-memory session revision to the existing single-server store;
login and discovery invalidate or reject old probes accordingly. It does not introduce saved
server lists or change the stable connection-restoration policy.

## Dependency review

- Reader: `4b3db91` to `0b75933bde1712bf693ca811b77ba3c921bd05a5`. The relevant Reader changes
  are already merged in Reader PRs #6/#7: OHOS plugin fallbacks, Chrome 96 runtime/viewport
  compatibility, duplicate menu cleanup and embedded font paths. Online reading is existing behavior.
- Tauri: `f8462993daf43e5c4b854df5949df2bce04c89d6`, combining app name/icon, safe-area,
  HAP version and dev-only dynamic ACL scope-ID fixes.
- Wry: official OHOS branch at `6aaf4b84b6e420015c6a14f264f1c7399f150392`.
- OHOS plugins: `abade34813aff19d15ee2529be7f5607deff9388`; fs 2.7.1 requires Rust >=1.90.
  Root Cargo patches apply on every target. The local Reader-plugin copies preserve licenses;
  their exact registry provenance, allowed differences and platform validation limits are recorded
  in `docs/ohos-upstream-validation.md`.

## Preserved boundaries

- Stable OHOS identity stays `org.houheya.moke`; the Preview Profile identity and CLI underscore
  exception are excluded. Existing REST/WS deadlines and sample-book deletion coordination remain.
- Preview entitlement, activation, device transfer/credentials, private distribution, gated updater,
  Preview capabilities/configuration, version bumps and signing changes are excluded.
- Stable release triggers, platform matrix, signatures, updater behavior and security checks remain.
  Workflow changes only align Node, CLI flags, reviewed icon copying and OHOS Rust profile preparation.
- Saved-server management, new continue-reading entries, reader-return redesign, original theme
  library, cover transitions and predictive/edge gestures are deferred to separate promotions.
- Source `057f49d`'s saved-list error UI is deferred with server management. Its underlying dynamic
  capability scope-ID fix is included through the intentional Tauri pin.
- Welcome-page version taps toggle only the debug float; About-page taps separately unlock
  developer settings. The float preference persists, but panel-open state does not. Locked
  release builds capture console output only while the panel is open, as documented in README.

## Review follow-ups

- Cover timeout begins when a worker starts the request. A 30-cover regression with six workers
  proves that a 16-second queue wait does not consume the active request's 15-second budget.
- Native recovery checks per-book mutation versions and pending work inside the IDB transaction.
  Both get/list reject snapshots that predate deletion or shelf changes, including committed native
  deletions whose IPC reply is still pending. Native-only recovery and sample-book coordination remain.
- Shared user-info parsing preserves the current-user-specific invalid-response message without
  changing the shared server-info error. Removed the unused standalone response parser.
- OHOS init/dev/build consistently merge the stable platform config before caller overrides;
  the pinned source CLI implements all three commands.
- Reader docs link the actual gitlink and distinguish historical desktop E2E evidence from current
  validation. Deferred server-management and Reader-return mechanisms are removed from the docs.

## Validation

- Node 24.21.0: complete host suite **588/588** passed.
- ESLint and TypeScript passed; ESLint retains **23 existing warnings**, no errors.
- Host and Reader production builds, plus Reader asset copying, passed.
- Linux `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked` passed and generated
  the extension command permissions and updated ACL schemas through the actual build script.
- Actual OHOS opener Rust transport module: **4/4** std-only tests passed.
- Production static frontend: **37/37** browser regressions passed, including legacy capability
  constraints, layouts, late startup insets, cover cancellation, real IndexedDB races, debug panel
  back handling and production console capture. Earlier dev layout/startup group: **19/19** passed.
- Offline dependency provenance checks cover **10 plugin patches / 385 local files** and reject
  code changes, file additions/removals and unsupported Cargo patch declarations. The optional
  registry verification also passed against **10 published archives / 494 original files**.
- Initial-head (`22e3d81`) GitHub CI Rust library tests, frontend quality, Web smoke and native
  browser regressions passed; the local follow-ups do not change Rust source.
- Workflow YAML and `git diff --check` passed. Existing CI gates are preserved; native frontend
  browser regressions are added separately, and quality tests initialize their contract, Tauri template and dependency-provenance inputs.

The initial desktop CI correctly rejected the mismatched HTTP JS/Rust minor versions before
compilation. Both halves now remain 2.5.9, with only upstream cancellation catches and idempotent
body disposal backported through a lockfile-pinned pnpm patch. Actual ESM/CJS package tests first
failed **6/6** on unpatched 2.5.9, then passed **6/6** with the patch, preserving real read errors.
A real Tauri CLI invocation passed its unchanged version check and reached an intentionally
stopped compiler-runner probe. This verifies the preflight, not a complete installer build.

Browser tests exercise the stable UI with synthetic native IPC and real browser IndexedDB.
They do not establish device acceptance.
Linux Rust checking does not establish OHOS/Android/iOS or Windows/macOS packaging compatibility.
The current environment has no configured OHOS SDK; HAP assembly, upgrade/data retention and
on-device back/forward navigation, safe-area and opener behavior remain platform acceptance work.

Performance, layout, native dependency provenance and offline recovery were handled in parallel;
an independent review found no blocking issue in the integrated follow-ups. The primary agent
reviewed the diffs and ran the combined host production build and browser regression suite.
