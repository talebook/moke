import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
);
const security = config.app.security;

function sources(policy, directive) {
  return new Set(policy[directive].split(/\s+/).filter(Boolean));
}

test('production CSP blocks unhashed inline scripts and lets Tauri hash emitted assets', () => {
  const scriptSources = sources(security.csp, 'script-src');
  assert.ok(scriptSources.has("'self'"));
  assert.ok(!scriptSources.has("'unsafe-inline'"));
  // Readest evaluates a bridge inside its book iframe, so unsafe-eval remains
  // an explicit compatibility exception; it does not authorize script tags.
  assert.ok(scriptSources.has("'unsafe-eval'"));
  assert.equal(security.dangerousDisableAssetCspModification, false);

  const layout = readFileSync(join(repoRoot, 'src/app/layout.tsx'), 'utf8');
  assert.equal((layout.match(/<script\b/g) ?? []).length, 2);
  assert.match(layout, /mokeReaderExitTransitionScript/);
  assert.match(layout, /MOKE-THEME-INIT/);
  // With asset CSP modification enabled, Tauri computes sha256 sources from
  // these exact emitted bodies (and Next's other generated inline scripts) at
  // compile time instead of relying on stale hand-maintained hashes.
});

test('development CSP is isolated from the release inline-script policy', () => {
  const developmentScripts = sources(security.devCsp, 'script-src');
  assert.ok(developmentScripts.has("'unsafe-inline'"));
  assert.ok(developmentScripts.has("'unsafe-eval'"));
  assert.ok(developmentScripts.has('http://localhost:*'));
  assert.ok(!sources(security.csp, 'script-src').has('http://localhost:*'));
});

test('CSP covers Tauri IPC/assets and embedded reader resource types', () => {
  const defaults = sources(security.csp, 'default-src');
  assert.ok(defaults.has("'self'"));
  assert.ok(defaults.has('tauri:'));
  assert.ok(defaults.has('http://tauri.localhost'));
  assert.ok(defaults.has('asset:'));
  assert.ok(defaults.has('http://asset.localhost'));

  const connections = sources(security.csp, 'connect-src');
  for (const source of ['ipc:', 'http://ipc.localhost', 'http:', 'https:', 'ws:', 'wss:']) {
    assert.ok(connections.has(source), `connect-src must include ${source}`);
  }

  const images = sources(security.csp, 'img-src');
  for (const source of ['data:', 'blob:', 'asset:', 'http://asset.localhost']) {
    assert.ok(images.has(source), `img-src must include ${source}`);
  }

  const frames = sources(security.csp, 'frame-src');
  assert.ok(frames.has('blob:'));
  assert.ok(frames.has('http:'), 'loopback extension UIs must remain loadable');
  assert.equal(security.csp['object-src'], "'none'");
  assert.equal(security.csp['frame-ancestors'], "'none'");
});

test('known third-party hosts remain compatible without arbitrary inline scripts', () => {
  const scripts = sources(security.csp, 'script-src');
  assert.ok(scripts.has('https://static.geetest.com'));
  assert.ok(!scripts.has('https://*.geetest.com'));
  assert.ok(scripts.has('https://*.stripe.com'));

  const styles = sources(security.csp, 'style-src');
  assert.ok(styles.has("'unsafe-inline'"));
  assert.ok(styles.has('https://fonts.googleapis.com'));
});

test('moke_navigate is compiled and registered only for OpenHarmony', () => {
  const source = readFileSync(join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');
  assert.match(
    source,
    /#\[cfg\(target_env = "ohos"\)\]\s*#\[tauri::command\]\s*fn moke_navigate/,
  );
  assert.match(
    source,
    /#\[cfg\(target_env = "ohos"\)\]\s*moke_navigate,/,
  );
});
