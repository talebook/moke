# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
