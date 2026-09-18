import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const rootPackage = readJson('package.json');
const stableConfig = readJson('src-tauri/tauri.conf.json');
const previewConfig = readJson('src-tauri/tauri.preview.conf.json');
const stableCapability = readJson('src-tauri/capabilities/default.json');
const previewCapability = readJson('src-tauri/capabilities/preview-default.json');
const cargoManifest = readText('src-tauri/Cargo.toml');
const nativeHost = readText('src-tauri/src/lib.rs');
const nativeBuildChannel = readText('src-tauri/src/build_channel.rs');
const nativeBuildConfig = readText('src-tauri/build_config.rs');
const previewModule = readText('src-tauri/src/preview/mod.rs');
const previewEntitlement = readText('src-tauri/src/preview/entitlement.rs');
const previewEnvironment = readText('.env.preview');
const updateStore = readText('src/lib/store/update.ts');

test('Preview is a compile-time Rust channel instead of a version-string gate', () => {
  assert.match(cargoManifest, /^default = \[\]$/m);
  assert.match(
    cargoManifest,
    /^preview = \[[^\n]+dep:base64[^\n]+dep:reqwest[^\n]+dep:ring[^\n]+dep:sha2[^\n]+\]$/m,
  );
  assert.match(nativeHost, /#\[cfg\(feature = "preview"\)\]\s*mod preview;/);
  assert.match(nativeBuildChannel, /cfg!\(feature = "preview"\)/);
  assert.match(nativeBuildChannel, /preview_compiled: matches!\(channel, BuildChannel::Preview\)/);
  assert.match(previewModule, /mod entitlement;/);
  assert.match(previewEntitlement, /PreviewEntitlementState::NotConfigured/);
  assert.doesNotMatch(nativeBuildChannel, /package\.json|APP_VERSION|version/);
});

test('Preview build uses an isolated app identity and build environment', () => {
  assert.notEqual(previewConfig.identifier, stableConfig.identifier);
  assert.equal(previewConfig.identifier, 'org.houheya.moke.preview');
  assert.equal(previewConfig.productName, 'Moke Preview');
  assert.match(previewConfig.app.windows[0].title, /Preview/);
  assert.notEqual(
    previewConfig.bundle.windows.wix.upgradeCode,
    stableConfig.bundle.windows.wix.upgradeCode,
  );
  assert.deepEqual(previewConfig.app.security.capabilities, [
    'preview-default',
    'reader',
    'reader-mobile',
    'reader-android-navigation',
  ]);
  assert.match(previewEnvironment, /^NEXT_PUBLIC_APP_PLATFORM=tauri$/m);
  assert.match(previewEnvironment, /^NEXT_PUBLIC_BUILD_CHANNEL=preview$/m);
  assert.match(rootPackage.scripts['build:preview'], /\.env\.preview/);
  assert.match(rootPackage.scripts['build:preview'], /strip-reader-sourcemaps\.mjs out/);
  assert.match(rootPackage.scripts['tauri:build:preview'], /--features preview/);
  assert.match(rootPackage.scripts['tauri:build:preview'], /tauri\.preview\.conf\.json/);
  assert.match(nativeBuildConfig, /validate_preview_build_channel/);
  assert.match(nativeBuildConfig, /beforeBuildCommand/);
  assert.match(nativeBuildConfig, /CARGO_FEATURE_PREVIEW|preview_feature/);
});

test('Preview cannot silently use the stable updater channel', () => {
  assert.deepEqual(previewConfig.plugins.updater.endpoints, []);
  assert.equal(previewConfig.bundle.createUpdaterArtifacts, false);
  assert.ok(stableCapability.permissions.includes('updater:default'));
  assert.ok(!previewCapability.permissions.includes('updater:default'));
  assert.ok(previewCapability.permissions.includes('allow-moke-build-info'));
  assert.match(
    nativeHost,
    /cfg\(all\(not\(target_env = "ohos"\), not\(feature = "preview"\)\)\)[\s\S]*?tauri_plugin_updater/,
  );
  assert.match(updateStore, /BUILD_CHANNEL === 'preview'/);
  assert.match(updateStore, /Preview packages must never fall through to the stable updater/);
});
