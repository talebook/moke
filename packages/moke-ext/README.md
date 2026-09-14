# moke-ext — Moke Extension CLI

Scaffold, build, validate, and package Moke extensions.

## Install

```bash
# From the tools/moke-ext directory:
npm link

# Or add to PATH:
set PATH=%PATH%;C:\path\to\talebook-client\tools\moke-ext\bin
```

## Commands

### `moke-ext init <name>`

Create a new extension project with manifest.json, ui/index.html, and README.

```bash
moke-ext init reading-stats
cd reading-stats
```

### `moke-ext validate`

Check manifest.json for correctness (fields, types, permissions whitelist).

```bash
moke-ext validate
```

### `moke-ext build`

Prepare the `dist/` directory for packaging:
- Copies manifest.json, icon.png, ui/
- Builds backend/Cargo.toml if present (cargo build --release)
- Copies the compiled binary

```bash
moke-ext build
```

### `moke-ext package`

Build an NSIS installer from dist/. Requires NSIS installed (`makensis` in PATH).

```bash
moke-ext package
# → dist/reading-stats-setup.exe
```

### `moke-ext sign`

Sign the built `dist/` package with an Ed25519 publisher key. Native backends
must be signed before Moke will execute them.

```bash
openssl genpkey -algorithm Ed25519 -out ../publisher.pem
moke-ext build
moke-ext sign --key ../publisher.pem --key-id release-2026
moke-ext package
```

The manifest must include `publisher.id`, `publisher.name`, and an HTTPS
`publisher.source`. Keep the private key outside the extension directory.

### `moke-ext dev`

Start a local development server for the extension UI on port 19557.

```bash
moke-ext dev --port 19557
```

## Quick workflow

```bash
moke-ext init my-extension
cd my-extension
# Edit manifest.json, ui/index.html...
moke-ext validate
moke-ext build
moke-ext sign --key ../publisher.pem --key-id release-2026
moke-ext package
```

See [`docs/extension-trust-model.md`](../../docs/extension-trust-model.md) in the Moke repository for the signed
payload, upgrade/permission confirmation rules, token rotation, and revocation
procedure.
