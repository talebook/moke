# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, OpenCode, Codex,
Cursor, Aider, Gemini CLI, etc.) when working with code in this repository.
The `agents.md` spec is the canonical home for this convention.

## What this is

**Moke** (package name `moke`, product name `Moke`) is a desktop client for a self-hosted
[Talebook](https://github.com/talebook/talebook) ebook server. The UI is a Next.js 16 / React 19
App Router app (Chinese-language, `zh-CN`), packaged as a single **Tauri v2** desktop binary.
It talks to a user-supplied Talebook server over HTTP(S), browses/searches the library, downloads
books for offline reading, and hands them to an **embedded readest reader** for the actual reading
experience.

## Commands

This is a Windows-first Tauri project. Use **pnpm** (a `pnpm-workspace.yaml` pins the root as the
only workspace package; `readest/` is its own separate pnpm workspace).

```bash
pnpm dev            # Next.js dev server (port 3000), tauri env (.env.tauri)
pnpm dev-web        # Next.js dev server, web env (.env.web)
pnpm build          # next build for tauri (static export → out/)
pnpm build-web      # next build for web deployment (server output)
pnpm lint           # next lint
pnpm typecheck      # tsc --noEmit
pnpm tauri dev      # full desktop app: compiles Rust + runs Next dev (slow, compiles readest's Rust)
pnpm tauri build    # production desktop bundle (runs build + build:reader + copy:reader first)

# Reader frontend (built into the same out/ as a separate Next app):
pnpm build:reader   # builds readest-app frontend → out/readest (via readest's own pnpm workspace)
pnpm copy:reader    # fallback copy of readest/out/readest → out/readest
```

There is no test suite in this repo. (The embedded `readest/apps/readest-app` has its own tests and
its own `CLAUDE.md` — consult that file before touching reader code.)

### Build-environment gotcha (Windows + WSL)

The **Bash tool runs in WSL2 Linux and has no cargo/node/pnpm**, while Read/Edit/Glob/Grep operate
on the Windows filesystem via `C:\...` paths. To run the real Windows toolchain from Bash, go through
interop, e.g. `powershell.exe -NoProfile -Command "Set-Location 'C:\...'; cargo ..."`
(Windows cargo: `C:\Users\Administrator\.cargo\bin\cargo.exe`). Bash's startup cwd is a deleted temp
dir, so commands print a harmless `cwd: No such file or directory` to stderr that can garble captured
stdout — have Windows commands write to a log file and read it back with the Read tool.

## Platform switch: tauri vs web

Almost all platform branching keys off `process.env.NEXT_PUBLIC_APP_PLATFORM` (`'tauri'` | `'web'`),
set by `dotenv-cli` loading `.env.tauri` / `.env.web`. `next.config.mjs` uses `output: 'export'`
(static export) for tauri production builds and a normal server build for web. When adding code that
differs by platform, follow the existing pattern: `const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri'`
and dynamically `import('@tauri-apps/...')` only inside the tauri branch so web builds don't pull in
Tauri APIs.

## Architecture

### Frontend (`src/`)

- `src/app/**` — App Router pages: `welcome` (enter server URL) → `access` (invite/access code) →
  `login`/`register` → `shelf`/`library`/`search`/`detail`/`user`/`settings`. `src/app/page.tsx`
  just redirects to `/welcome` or `/shelf` based on whether a server is configured.
- `src/lib/api.ts` — **the single HTTP layer**. All server calls go through `request()`. Read its
  header comments before changing it; the constraints are real:
  - Tauri desktop **must use absolute `http(s)://` URLs** (no current origin to resolve against) and
    fetches via `@tauri-apps/plugin-http` with `danger.acceptInvalidCerts` + `maxRedirections` so
    self-signed / plain-HTTP LAN Talebook servers and login redirects work. Web uses native `fetch`.
  - `<img src>` can't carry the Rust-side session cookie cross-origin, so cover/image loads must go
    through `fetchImageObjectUrl()` (fetch bytes via `request()`, return an object URL).
- `src/lib/store/server.ts` — zustand store (`persist`, key `moke-server-storage`) holding
  `serverUrl`, connection state, and user. This is the source of truth for "which server am I on".
  **Never use `window.location.href` for navigation** in the Tauri static-export build — a full-page
  nav reloads the WebView and wipes all in-memory state (zustand resets, serverUrl lost). Use
  `router.push`/`router.replace`.
- `src/components/providers/ServerProvider.tsx` — wraps the app; after store hydration it redirects
  to `/welcome` when no server, checks the access-code requirement, and syncs current user + server
  title. `publicPaths` lists routes exempt from the redirect.
- `src/lib/offline-books.ts` — offline downloads. Stored in IndexedDB (`moke-offline-books`), and on
  Tauri additionally written to disk under `AppData/books/` via `@tauri-apps/plugin-fs` so the reader
  can open a real file path.
- `@/*` → `src/*` and `@pdfjs/*` → `public/vendor/pdfjs/*` path aliases (`tsconfig.json`).

### Tauri backend (`src-tauri/`)

- `src-tauri/src/lib.rs` is intentionally thin. Moke's only own command is `open_reader`, which calls
  `readestlib::open_reader_window(...)`; the frontend opens the reader via `invoke('open_reader', { filePath })`.
- **The reader is embedded as a Rust library dependency**, not a subprocess: `Cargo.toml` depends on
  `readestlib` (package `Readest`, at `../readest/apps/readest-app/src-tauri`, `default-features=false`
  to disable readest's standalone `run()`). All of readest's backend commands are re-registered at the
  app level in `lib.rs`'s `generate_handler!` (they must be top-level, not plugin-namespaced, because
  the reader frontend calls them as bare command names). The result is one binary.
- **Tauri ACL quirk** (documented in `Cargo.toml`): any plugin whose permissions appear in
  `capabilities/default.json` (dialog, turso, native-tts, websocket, etc.) must be a **direct**
  dependency of `moke`, because permission manifests exposed via cargo `links` don't propagate through
  the `readestlib` layer. So those plugins are listed as direct deps purely so `build.rs` finds the
  permissions; actual plugin *registration* still happens once in `readestlib::register_reader_plugins`.
- `src-tauri/gen/schemas/*` are generated — don't hand-edit.

### The `readest/` reader (`readest/apps/readest-app`)

A near-complete copy of the [readest](https://github.com/readest/readest) reader, integrated as a
**separate Next.js frontend**: it builds with `basePath:/readest` and `distDir:../../out/readest` into
the *same* `out/` directory, so Tauri's `frontendDist: "../out"` ships both apps. In dev the reader
runs on port 3001 (`localhost:3001/reader`); in a build it's served at `/readest/reader`. Moke builds
**only readest's frontend, never its `src-tauri` `run()`** (that's why `default-features=false`).

As of 2026-06-29, `readest/` is a **plain folder in this repo** (formerly a git submodule, flattened
along with its nested submodules; readest git history discarded). Edit reader code directly under
`readest/apps/readest-app/` — it's normal committable source. Do **not** propose merging the two apps
into one package.json/single build: that was evaluated and rejected (113+57 deps, `@/*` alias clash,
`app/{library,opds,user}` route-segment collisions). The reader depends on the workspace package
`packages/foliate-js` and cannot be lifted out on its own.

### `CODE_NEED/talebook/`

A reference checkout of the upstream Talebook **server** (Python) kept for API reference. Not part of
the client build.

## Setup gotchas

### Reader vendor files (pdfjs, simplecc, jieba) must be generated after `git submodule update`

`readest/apps/readest-app/tsconfig.json` aliases `@pdfjs/*` and `@simplecc/*` to paths under the
**reader app's own** `public/vendor/` (not the moke root's `public/vendor/`). Those vendor files
live in the submodules `packages/foliate-js` and `packages/simplecc-wasm` and are not committed.
After pulling submodules (`git submodule update --init --recursive`), run:

```bash
cd readest/apps/readest-app
pnpm setup-vendors
```

This populates `public/vendor/{pdfjs,simplecc,jieba}`. Without it, `pnpm build:reader` fails with
`Module not found: '@pdfjs/pdf.min.mjs'` / `'@simplecc/simplecc_wasm'`. Re-run after a `git pull`
that updates the readest submodules.

## E-ink mode adaptation

Moke has a **墨水屏模式 (e-ink mode)** toggle in Settings (stored in the `useSettingsStore` zustand
store as `eink: boolean`, also exposed at runtime as `window.__MOKE_EINK`). It's enabled in two
overlapping ways:

1. **Manual override** — the Settings toggle writes `data-eink="true"` on `<html>`. This is what users
   hit via the switcher; everything below targets this attribute.
2. **Auto-detect** — CSS `@media (update: slow), (max-color: 1)` (Kindle and slow-refresh e-ink) also
   applies a flat white-bg / no-shadow / grayscale-image global reset. The manual override is more
   granular and gets the rules below.

### How to make new code e-ink-safe

**All e-ink styling lives in `src/app/globals.css`**, not in component classes. The convention is
CSS attribute selectors that target a class-substring pattern and force a high-contrast black/white
value. The rules fall into these buckets:

| Pattern (in className) | E-ink replacement | Why |
|---|---|---|
| `bg-white/N`, `bg-[#fffdf8]/N`, `app-glass`, `app-card` | solid `#FFFFFF` + black border | translucency shows content behind, blur smears |
| `header` | solid `#FFFFFF` + 1px black bottom border | the warm cream header bg is dirty on e-ink |
| `bg-primary` | `#FFFFFF` + 1px black border + black text | the brown CTA collapses to muddy gray with white text |
| `moke-shelf-bg`, `moke-sidebar` | solid `#FFFFFF` | gradient/radial backgrounds → solid white |
| `text-foreground`, `text-foreground/N` | `#000000` | the body color override doesn't reach classes that set an explicit color |
| `text-muted-foreground`, `text-muted-foreground/N` | `#555555` | warm gray washes out on white, `#555555` is the sidebar convention |
| `text-primary`, `text-primary/N` | `#000000` | small caption text like "共 13 本藏书" / "探索书库" |
| `text-amber-*`, `text-rose-*`, `text-red-*`, `text-green-*`, `text-blue-*`, etc. | `#000000` | decorative colored icons collapse to arbitrary gray smears; covers destructive (red), success (green), and the about-page section header icons (amber-500, rose-500) |
| `border-amber-950/N` | `#000000` | the standard warm hairline border; critical for Select dropdown and BookContextMenu outlines |
| `border-foreground`, `border-foreground/N` | `#000000` | active-tab and selected-element borders |
| `border-border`, `border-border/N` | `#000000` | the standard light-gray border |
| `border-primary/N` | `#000000` | brown accent border (e.g. on hover) |
| `bg-muted`, `bg-muted/N` (not `hover:`, not `bg-muted-foreground`) | `#E5E5E5` | the warm light-gray surface (icon containers, active tabs, etc.) |
| `hover:bg-muted*` `:hover` / `:focus-visible` | `#E5E5E5` | interactive hover/focus only — **must use `:hover` to avoid persistent gray** (see pitfall below) |
| `hover:bg-amber-*` `:hover` / `:focus-visible` | `#E5E5E5` | Select options + BookContextMenu items hover |
| `bg-amber-50/40` (not `hover:`) | `#E5E5E5` | the persistent fill on the currently-selected Select option |
| `bg-background/N` | `#FFFFFF` | the cream page-background color used on history/user cards |
| `from-primary`, `via-primary`, `to-primary` | `#000000` (via `background:` shorthand) | brown gradient avatar/icon containers invert to solid black |
| `from-{emerald,teal,cyan,amber,yellow,orange,slate,gray,zinc,stone,neutral,rose,red,pink,indigo,blue,purple,violet,fuchsia,sky,lime,green}-*` | `#E5E5E5` (via `background:` shorthand) | colored book-cover placeholder gradients — collapses to a neutral "no-cover" surface; the rule also strips the gradient image, so `via-`/`to-` stops don't need separate handling |
| `from-{above color}-* [class*='text-white/']` (descendant) | descendant `color: #000000` | the white initial/text inside a colored cover placeholder (text-white/75) would be unreadable on the now-gray bg; forces the inner text to black |
| `backdrop-blur*`, `shadow-[...]`, `blur-2xl`, `from-white/`, `from-black/` | stripped (display:none / none) | smears and decorative gradients add no value on e-ink |

### PITFALL — `[class*='...']` substring matching catches hover variants

CSS attribute substring matching is greedy: `[class*='bg-muted']` also matches `hover:bg-muted/60`
(because "bg-muted" is a substring). If the rule has no `:hover` pseudo-class and no `:not()`
exclusion, the **default (non-hover) state will show the e-ink color persistently** — and the
hover state will look identical, so users lose the hover affordance.

The escape hatches are:

1. **For genuinely interactive hovers** — pair the pattern with `:hover`:
   ```css
   [data-eink='true'] [class*='hover:bg-muted']:hover { background-color: #E5E5E5 !important; }
   ```
2. **For non-hover static classes that share a prefix with a hover variant** — exclude the hover
   variant explicitly:
   ```css
   [data-eink='true'] [class*='bg-muted']:not([class*='hover:bg-muted']):not([class*='bg-muted-foreground']) { ... }
   [data-eink='true'] [class*='bg-amber-50/40']:not([class*='hover:bg-amber-50/40']) { ... }
   ```

Whenever you add a new e-ink rule, ask: "does the pattern I'm matching also appear as a
`hover:`-prefixed class in any component? If so, the rule will leak to the non-hover state." Add
the corresponding `:not()` or pair it with `:hover`.

### Two-mode class convention (use sparingly)

For one-off differences (e.g. the ViewModeToggle in the navbar), Tailwind's `eink:` variant is fine:
```jsx
className="eink:!bg-black eink:!text-white eink:!shadow-[inset_0_0_0_1px_#000]"
```
The `!` after `eink:` is important — e-ink rules must beat the base styles, including any
`!important` ones in `@layer utilities`. Reach for this only when a global CSS substring rule
would be too coarse (e.g. needing different rules for ACTIVE vs INACTIVE within the same component).

### Per-component e-ink responsibility

A few components own e-ink-specific logic that doesn't fit the global pattern. Don't re-implement
these in globals.css — the component is the source of truth:

- `src/components/book/ViewModeToggle.tsx` — active vs inactive button states (filled black vs
  outlined white) within the toggle group.
- `src/components/book/BookContextMenu.tsx` and `src/components/ui/Select.tsx` — already share
  the right-click menu visual language (`border-amber-950/10 bg-white/95 backdrop-blur`); the
  global rules above handle their e-ink adaptation without per-component code.
