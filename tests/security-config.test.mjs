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
  assert.match(layout, /mokeDocumentTransitionGuardScript/);
  assert.match(layout, /MOKE-THEME-INIT/);
  // With asset CSP modification enabled, Tauri computes sha256 sources from
  // these exact emitted bodies (and Next's other generated inline scripts) at
  // compile time instead of relying on stale hand-maintained hashes.
});

test('development CSP grants scripts and styles only the two local dev ports', () => {
  const localDevOrigins = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://localhost:3000',
    'http://localhost:3001',
  ];
  const localSource = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|$)/;

  for (const directive of ['script-src', 'style-src']) {
    const productionSources = sources(security.csp, directive);
    const developmentSources = sources(security.devCsp, directive);
    assert.deepEqual(
      [...developmentSources].filter((source) => localSource.test(source)).sort(),
      localDevOrigins,
    );
    assert.deepEqual(
      [...productionSources].filter((source) => localSource.test(source)),
      [],
    );
  }

  const developmentScripts = sources(security.devCsp, 'script-src');
  assert.ok(developmentScripts.has("'unsafe-inline'"));
  assert.ok(developmentScripts.has("'unsafe-eval'"));
});

test('CSP covers Tauri IPC/assets and embedded reader resource types', () => {
  const defaults = sources(security.csp, 'default-src');
  assert.ok(defaults.has("'self'"));
  assert.ok(defaults.has('tauri:'));
  assert.ok(defaults.has('http://tauri.localhost'));
  assert.ok(defaults.has('asset:'));
  assert.ok(defaults.has('http://asset.localhost'));
  assert.ok(!defaults.has('customprotocol:'), 'unregistered schemes must not be allowlisted');

  const connections = sources(security.csp, 'connect-src');
  for (const source of [
    'ipc:',
    'http://ipc.localhost',
    'rangefile:',
    'http://rangefile.localhost',
    'http:',
    'https:',
    'ws:',
    'wss:',
  ]) {
    assert.ok(connections.has(source), `connect-src must include ${source}`);
  }

  const images = sources(security.csp, 'img-src');
  for (const source of ['data:', 'blob:', 'asset:', 'http://asset.localhost']) {
    assert.ok(images.has(source), `img-src must include ${source}`);
  }

  const frames = sources(security.csp, 'frame-src');
  assert.ok(frames.has('blob:'));
  assert.ok(frames.has('http:'), 'loopback extension UIs must remain loadable');
  assert.ok(!frames.has('rangefile:'), 'rangefile is a fetch transport, not a frame source');
  assert.equal(security.csp['object-src'], "'none'");
  assert.equal(security.csp['frame-ancestors'], "'none'");
});

test('production and development CSPs do not allow unregistered customprotocol URLs', () => {
  for (const policy of [security.csp, security.devCsp]) {
    for (const directive of Object.keys(policy)) {
      assert.ok(!sources(policy, directive).has('customprotocol:'), `${directive} must omit customprotocol:`);
    }
  }
});

test('production script hosts are limited to shipped runtime loaders', () => {
  const scripts = sources(security.csp, 'script-src');
  assert.deepEqual([...scripts].sort(), [
    "'self'",
    "'unsafe-eval'",
    'asset:',
    'http://asset.localhost',
    'https://static.geetest.com',
    'https://us-assets.i.posthog.com',
  ].sort());

  const captchaCore = readFileSync(
    join(repoRoot, 'src/lib/captcha-core.ts'),
    'utf8',
  );
  assert.match(captchaCore, /https:\/\/static\.geetest\.com\/v4\/gt4\.js/);
  // The pinned Readest export bundles PostHog and constructs its US
  // external-dependency asset endpoint at runtime. Its API stays under the
  // broader connect-src policy. Stripe checkout is not in the Tauri static
  // route graph, and the Sentry URL in that bundle is only an issue-link value,
  // so neither receives script execution permission.
});

test('embedded reader stylesheet hosts remain available without extra hosts', () => {
  const styles = sources(security.csp, 'style-src');
  assert.deepEqual([...styles].sort(), [
    "'self'",
    "'unsafe-inline'",
    'asset:',
    'blob:',
    'http://asset.localhost',
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
    'https://fonts.googleapis.com',
    'https://storage.readest.com',
  ].sort());
});

test('Moke host commands use exact window/platform ACL and document guards', () => {
  const source = readFileSync(join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');
  const readerService = readFileSync(
    join(repoRoot, 'readest/apps/readest-app/src/services/nativeAppService.ts'),
    'utf8',
  );
  const capabilities = Object.fromEntries(
    [
      'default.json',
      'reader.json',
      'reader-mobile.json',
      'reader-android-navigation.json',
      'ohos.json',
    ].map((name) => [
      name,
      JSON.parse(readFileSync(join(repoRoot, 'src-tauri/capabilities', name), 'utf8')),
    ]),
  );
  const permissions = (name) => new Set(capabilities[name].permissions);

  assert.match(
    source,
    /#\[cfg\(any\(target_env = "ohos", target_os = "android"\)\)\]\s*#\[tauri::command\]\s*fn moke_navigate/,
  );
  assert.match(
    source,
    /#\[cfg\(any\(target_env = "ohos", target_os = "android"\)\)\]\s*moke_navigate,/,
  );
  assert.match(source, /fn require_moke_shell[\s\S]*is_moke_shell_path/);
  assert.match(source, /fn moke_navigate[\s\S]*is_allowed_moke_navigation\(&source, &target\)/);
  assert.match(
    source,
    /is_moke_shell_path\(source\.path\(\)\)[\s\S]*target\.path\(\) == "\/readest\/reader"/,
  );
  assert.match(
    source,
    /is_moke_reader_path\(source\.path\(\)\)[\s\S]*target\.path\(\) == "\/library" && target\.query\(\)\.is_none\(\)/,
  );
  assert.match(source, /target\.fragment\(\)\.is_some\(\)/);
  assert.match(source, /fn schedule_moke_navigation[\s\S]*from_millis\(100\)/);

  for (const command of [
    'allow-moke-list-downloaded-books',
    'allow-moke-get-download-directory',
  ]) {
    assert.ok(permissions('default.json').has(command));
    assert.ok(permissions('reader-mobile.json').has(command));
    assert.ok(permissions('ohos.json').has(command));
    assert.ok(!permissions('reader.json').has(command));
  }

  assert.deepEqual(capabilities['reader-android-navigation.json'].platforms, ['android']);
  assert.deepEqual(capabilities['reader-android-navigation.json'].windows, ['main']);
  assert.deepEqual(capabilities['reader-android-navigation.json'].permissions, ['allow-moke-navigate']);
  assert.ok(permissions('ohos.json').has('allow-moke-navigate'));
  for (const name of ['default.json', 'reader.json', 'reader-mobile.json']) {
    assert.ok(!permissions(name).has('allow-moke-navigate'));
  }

  for (const capability of Object.values(capabilities)) {
    assert.ok(!capability.windows.includes('*'));
    assert.ok(!new Set(capability.permissions).has('allow-set-webview-info'));
  }
  assert.match(readerService, /if \(!window\.__MOKE_EMBEDDED\)[\s\S]*invoke\('set_webview_info'/);
});
