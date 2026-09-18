import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const cargoManifest = readText('src-tauri/Cargo.toml');
const nativeHost = readText('src-tauri/src/lib.rs');
const entitlement = readText('src-tauri/src/preview/entitlement.rs');
const gate = readText('src/components/providers/PreviewEntitlementGate.tsx');
const globalStyles = readText('src/app/globals.css');
const privacyGate = readText('src/components/providers/PrivacyConsentGate.tsx');
const previewCapability = readJson('src-tauri/capabilities/preview-default.json');

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

test('only the Preview host capability can call entitlement commands', () => {
  for (const permission of [
    'allow-moke-preview-activate',
    'allow-moke-preview-entitlement-status',
    'allow-moke-preview-refresh',
  ]) {
    assert.ok(previewCapability.permissions.includes(permission));
  }
});
