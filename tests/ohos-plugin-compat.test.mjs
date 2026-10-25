import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPluginFiles, verifyVendorPluginProvenance } from '../scripts/check-vendor-plugin-provenance.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every all-target Cargo plugin patch matches the reviewed exact provenance', async () => {
  const result = await verifyVendorPluginProvenance();
  assert.equal(result.plugins, 10);
  assert.equal(result.registryVerified, false);
});

test('provenance rejects changed desktop code, extra files and missing files in a temporary copy', (t) => {
  const manifest = JSON.parse(read('docs/vendor-plugin-provenance.json'));
  const plugin = manifest.plugins.find((entry) => entry.name === 'tauri-plugin-biometric');
  const root = mkdtempSync(path.join(tmpdir(), 'moke-plugin-tamper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL(`../${plugin.path}`, import.meta.url)), path.join(root, plugin.path), { recursive: true });
  verifyPluginFiles(plugin, root);

  // This file already has an allowed OHOS patch. Its declaration must never
  // authorize arbitrary additional code for desktop or any other platform.
  const source = path.join(root, plugin.path, 'src/lib.rs');
  const original = readFileSync(source);
  writeFileSync(source, `${original.toString()}\n#[cfg(desktop)] pub fn unreviewed_desktop_change() {}\n`);
  assert.throws(() => verifyPluginFiles(plugin, root), /src\/lib\.rs: unexpected content/);
  writeFileSync(source, original);

  const added = path.join(root, plugin.path, 'src/unreviewed.rs');
  writeFileSync(added, 'pub fn unreviewed() {}');
  assert.throws(() => verifyPluginFiles(plugin, root), /file inventory changed/);
  rmSync(added);
  rmSync(source);
  assert.throws(() => verifyPluginFiles(plugin, root), /file inventory changed/);
});

test('provenance rejects unsupported Cargo patch formats instead of silently skipping entries', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-plugin-patch-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'src-tauri'));
  writeFileSync(path.join(root, 'docs/vendor-plugin-provenance.json'), read('docs/vendor-plugin-provenance.json'));
  const cargo = read('src-tauri/Cargo.toml');
  const additions = [
    'tauri-plugin-unreviewed = { path = "../vendor/tauri-plugin-unreviewed", version = "1" }',
    'tauri-plugin-unreviewed = {\n path = "../vendor/tauri-plugin-unreviewed"\n}',
    '"tauri-plugin-unreviewed" = { path = "../vendor/tauri-plugin-unreviewed" }',
    'tauri-plugin-unreviewed.path = "../vendor/tauri-plugin-unreviewed"',
    '[patch.crates-io.tauri-plugin-unreviewed]\npath = "../vendor/tauri-plugin-unreviewed"',
  ];
  for (const addition of additions) {
    writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), cargo.replace('[patch.crates-io]', `[patch.crates-io]\n${addition}`));
    await assert.rejects(verifyVendorPluginProvenance({ root }), /Unsupported Cargo plugin patch format/);
  }
});

const patchedPlugins = [
  ['device-info', '../vendor/tauri-plugin-device-info'],
  ['log', '../vendor/tauri-plugin-log'],
  ['deep-link', '../vendor/tauri-plugin-deep-link'],
  ['sign-in-with-apple', '../vendor/tauri-plugin-sign-in-with-apple'],
  ['sharekit', '../vendor/tauri-plugin-sharekit'],
  ['haptics', '../vendor/tauri-plugin-haptics'],
  ['biometric', '../vendor/tauri-plugin-biometric'],
];

test('OHOS compatibility plugins are pinned to one local Cargo package', () => {
  const manifest = read('src-tauri/Cargo.toml');
  const packages = read('src-tauri/Cargo.lock').split('[[package]]');

  for (const [name, path] of patchedPlugins) {
    assert.ok(
      manifest.includes(`tauri-plugin-${name} = { path = "${path}" }`),
      `tauri-plugin-${name} must use its local OHOS compatibility copy`,
    );
    const locked = packages.filter((entry) => entry.includes(`\nname = "tauri-plugin-${name}"\n`));
    assert.equal(locked.length, 1, `tauri-plugin-${name} must resolve once`);
    assert.doesNotMatch(locked[0], /\nsource = /, `tauri-plugin-${name} must not resolve from crates.io`);
  }
});

test('registered plugins avoid Android and iOS handles on OHOS', () => {
  const deviceInfo = read('vendor/tauri-plugin-device-info/src/lib.rs');
  assert.match(deviceInfo, /cfg\(all\(mobile, not\(target_env = "ohos"\)\)\)[\s\S]*mod mobile/);
  assert.match(deviceInfo, /cfg\(target_env = "ohos"\)[\s\S]*mod ohos/);
  assert.match(read('vendor/tauri-plugin-device-info/src/ohos.rs'), /Ok\(BatteryInfo::default\(\)\)/);

  const log = read('vendor/tauri-plugin-log/src/lib.rs');
  assert.match(log, /cfg\(any\(desktop, target_env = "ohos"\)\)[\s\S]*TargetKind::Stdout/);
  assert.match(log, /cfg\(any\(desktop, target_env = "ohos"\)\)[\s\S]*TargetKind::Stderr/);

  const deepLink = read('vendor/tauri-plugin-deep-link/src/lib.rs');
  assert.match(deepLink, /cfg\(target_env = "ohos"\)[\s\S]*Ok\(DeepLink/);
  assert.match(deepLink, /all\(target_os = "linux", not\(target_env = "ohos"\)\)/);
});

test('transitive mobile-only plugins expose explicit OHOS fallbacks', () => {
  for (const plugin of ['sign-in-with-apple', 'haptics']) {
    const source = read(`vendor/tauri-plugin-${plugin}/src/lib.rs`);
    assert.match(source, /cfg\(any\(desktop, target_env = "ohos"\)\)/);
    assert.match(source, /cfg\(all\(mobile, not\(target_env = "ohos"\)\)\)/);
  }

  const sharekit = read('vendor/tauri-plugin-sharekit/src/lib.rs');
  assert.match(sharekit, /target_env = "ohos"[\s\S]*mod desktop/);
  assert.match(sharekit, /cfg\(all\(mobile, not\(target_env = "ohos"\)\)\)/);

  const biometric = read('vendor/tauri-plugin-biometric/src/lib.rs');
  assert.match(biometric, /Biometric authentication is not supported on OpenHarmony/);
  assert.match(biometric, /return Err\(crate::Error::UnsupportedPlatform\)/);
});

test('Reader native plugins select their existing fallback backends on OHOS', () => {
  for (const plugin of ['native-bridge', 'native-tts']) {
    const source = read(
      `readest/apps/readest-app/src-tauri/plugins/tauri-plugin-${plugin}/src/lib.rs`,
    );
    assert.match(source, /cfg\(any\(desktop, target_env = "ohos"\)\)[\s\S]*mod desktop/);
    assert.match(source, /cfg\(all\(mobile, not\(target_env = "ohos"\)\)\)[\s\S]*mod mobile/);
  }
});
