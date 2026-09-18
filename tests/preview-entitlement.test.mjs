import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertPreviewNativeBuild,
  effectiveEntitlementState,
  nextEntitlementBoundaryDelay,
} from '../src/lib/preview-entitlement.ts';

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const cargoManifest = readText('src-tauri/Cargo.toml');
const nativeHost = readText('src-tauri/src/lib.rs');
const entitlement = readText('src-tauri/src/preview/entitlement.rs');
const gate = readText('src/components/providers/PreviewEntitlementGate.tsx');
const globalStyles = readText('src/app/globals.css');
const privacyGate = readText('src/components/providers/PrivacyConsentGate.tsx');
const previewCapability = readJson('src-tauri/capabilities/preview-default.json');
const previewBootstrapCapability = readJson('src-tauri/capabilities/preview-bootstrap.json');
const previewModule = readText('src-tauri/src/preview/mod.rs');
const extensions = readText('src-tauri/src/extensions/mod.rs');

test('Preview entitlement implementation exists only behind the Rust preview feature', () => {
  assert.match(cargoManifest, /^preview = \[[^\n]+dep:ring[^\n]+\]$/m);
  assert.match(nativeHost, /#\[cfg\(feature = "preview"\)\]\s*mod preview;/);
  assert.match(
    nativeHost,
    /#\[cfg\(feature = "preview"\)\]\s*preview::entitlement::moke_preview_activate/,
  );
  assert.match(entitlement, /option_env!\("MOKE_PREVIEW_ENTITLEMENT_URL"\)/);
  assert.match(entitlement, /option_env!\("MOKE_PREVIEW_ENTITLEMENT_PUBLIC_KEY"\)/);
});

test('Preview leases are signed, device-bound, time-bounded, and fail closed', () => {
  assert.match(entitlement, /signature::ED25519/);
  assert.match(entitlement, /payload\.device_id != expected_device_id/);
  assert.match(entitlement, /MAX_ONLINE_LEASE_SECONDS/);
  assert.match(entitlement, /MAX_OFFLINE_WINDOW_SECONDS/);
  assert.match(entitlement, /ClockRollback/);
  assert.match(entitlement, /checkpoint_signature: String/);
  assert.match(entitlement, /verify_lease_checkpoint\(&record, &identity\)/);
  assert.match(entitlement, /PreviewEntitlementState::Active \| PreviewEntitlementState::OfflineGrace/);
  assert.doesNotMatch(entitlement, /danger_accept_invalid_certs|http:\/\//);
});

test('running Preview sessions transition at lease boundaries with a fake clock', () => {
  const status = {
    state: 'active',
    serviceConfigured: true,
    deviceId: 'moke_test',
    subject: 'tester',
    capabilities: ['foundation'],
    expiresAt: 1_800_000_100,
    offlineUntil: 1_800_000_200,
    message: 'active',
  };

  assert.equal(effectiveEntitlementState(status, 1_800_000_100_000), 'active');
  assert.equal(effectiveEntitlementState(status, 1_800_000_101_000), 'offlineGrace');
  assert.equal(effectiveEntitlementState(status, 1_800_000_201_000), 'expired');
  assert.equal(nextEntitlementBoundaryDelay(status, 1_800_000_099_500), 1_500);

  const offlineGrace = { ...status, state: 'offlineGrace' };
  assert.equal(
    effectiveEntitlementState(offlineGrace, 1_800_000_000_000),
    'offlineGrace',
    'a local clock rollback must not promote an observed grace lease back to active',
  );
});

test('Preview fails closed on native channel mismatch', () => {
  assert.doesNotThrow(() => assertPreviewNativeBuild({ channel: 'preview', previewCompiled: true }));
  assert.throws(
    () => assertPreviewNativeBuild({ channel: 'stable', previewCompiled: false }),
    /构建通道不一致/,
  );
});

test('Preview rechecks entitlement at time boundaries and lifecycle resumes', () => {
  assert.match(gate, /nextEntitlementBoundaryDelay/);
  assert.match(gate, /addEventListener\('focus', recheck\)/);
  assert.match(gate, /addEventListener\('pageshow', recheck\)/);
  assert.match(gate, /addEventListener\('visibilitychange', recheckWhenVisible\)/);
});

test('native IPC dispatch gates Moke, Reader, and extension commands', () => {
  assert.match(
    nativeHost,
    /preview::authorize_command\(invoke\.message\.webview_ref\(\)\.app_handle\(\), &cmd\)/,
  );
  assert.match(nativeHost, /invoke\.resolver\.reject\(error\)/);
  assert.match(entitlement, /lease_state_at\(&payload, now\)/);
});

test('native bootstrap owns privileged window and extension lifecycle', () => {
  assert.match(previewModule, /PREVIEW_BOOTSTRAP_WINDOW: &str = "preview-bootstrap"/);
  assert.match(previewModule, /WebviewWindowBuilder::new\([\s\S]*?PREVIEW_MAIN_WINDOW/);
  assert.match(previewModule, /require_preview_capability\(&app, PreviewCapability::Foundation\)\?/);
  assert.match(previewModule, /super::extensions::init\(&app_for_main_thread\)/);
  assert.match(previewModule, /super::extensions::shutdown\(&app\)/);
  assert.match(previewModule, /app\.request_restart\(\)/);
  assert.match(nativeHost, /not\(feature = "preview"\)[\s\S]*extensions::init\(_app\.handle\(\)\)/);
  assert.match(extensions, /pub fn shutdown\(app: &AppHandle\)/);
});

test('locked bootstrap cannot mint a reader window or call privileged plugins', () => {
  const permissions = previewBootstrapCapability.permissions.map((permission) =>
    typeof permission === 'string' ? permission : permission.identifier,
  );
  for (const forbidden of [
    'core:webview:allow-create-webview-window',
    'http:default',
    'process:allow-exit',
    'process:allow-restart',
    'allow-open-reader',
  ]) {
    assert.ok(!permissions.includes(forbidden), forbidden);
  }
  assert.deepEqual(previewBootstrapCapability.windows, ['preview-bootstrap']);
});

test('native entitlement fast path is cached but periodically revalidates durable state', () => {
  assert.match(entitlement, /CACHE_REVALIDATE_SECONDS/);
  assert.match(entitlement, /CHECKPOINT_INTERVAL_SECONDS/);
  assert.match(entitlement, /cached_status\(now, false\)/);
  assert.match(previewModule, /revalidate_preview_capability/);
  assert.match(previewModule, /ENTITLEMENT_MONITOR_INTERVAL/);
});

test('Preview entitlement surfaces have scoped e-ink treatments', () => {
  for (const className of [
    'preview-entitlement-banner',
    'preview-entitlement-dialog',
    'preview-entitlement-input',
  ]) {
    assert.match(gate, new RegExp(className));
    assert.match(globalStyles, new RegExp(`\\[data-eink='true'\\] \\.${className}`));
  }
  assert.doesNotMatch(globalStyles, /\[data-eink='true'\] \.bg-background\s*\{/);
});

test('access codes are transient and authorization precedes server synchronization', () => {
  assert.match(gate, /type="password"/);
  assert.match(gate, /autoComplete="one-time-code"/);
  assert.match(gate, /setAccessCode\(''\)/);
  assert.doesNotMatch(gate, /localStorage|sessionStorage/);
  assert.match(
    privacyGate,
    /<PreviewEntitlementGate>[\s\S]*<ServerProvider>[\s\S]*<ReaderProgressProvider>/,
  );
});

test('entitlement command permissions follow the bootstrap and authorized window roles', () => {
  for (const permission of [
    'allow-moke-preview-entitlement-status',
    'allow-moke-preview-refresh',
  ]) {
    assert.ok(previewCapability.permissions.includes(permission));
  }
  assert.ok(!previewCapability.permissions.includes('allow-moke-preview-activate'));
  assert.ok(!previewCapability.permissions.includes('allow-moke-preview-enter-app'));
  for (const permission of [
    'allow-moke-preview-activate',
    'allow-moke-preview-entitlement-status',
    'allow-moke-preview-enter-app',
  ]) {
    assert.ok(previewBootstrapCapability.permissions.includes(permission));
  }
});
