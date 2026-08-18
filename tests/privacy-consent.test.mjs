import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  acceptCurrentPrivacyPolicy,
  hasAcceptedCurrentPrivacyPolicy,
  PRIVACY_CONSENT_STORAGE_KEY,
  PRIVACY_POLICY_VERSION,
} from '../src/lib/privacy-consent.ts';

const appShellSource = readFileSync(
  fileURLToPath(new URL('../src/components/providers/AppShell.tsx', import.meta.url)),
  'utf8',
);
const consentGateSource = readFileSync(
  fileURLToPath(new URL('../src/components/providers/PrivacyConsentGate.tsx', import.meta.url)),
  'utf8',
);

test('当前版本隐私政策只有明确同意后才会放行', () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };

  assert.equal(hasAcceptedCurrentPrivacyPolicy(), false);
  values.set(PRIVACY_CONSENT_STORAGE_KEY, 'old-policy-version');
  assert.equal(hasAcceptedCurrentPrivacyPolicy(), false);

  acceptCurrentPrivacyPolicy();
  assert.equal(values.get(PRIVACY_CONSENT_STORAGE_KEY), PRIVACY_POLICY_VERSION);
  assert.equal(hasAcceptedCurrentPrivacyPolicy(), true);
});

test('隐私确认门在服务器同步组件之外，且提供同意与拒绝操作', () => {
  assert.match(
    appShellSource,
    /<PrivacyConsentGate>[\s\S]*<ServerProvider>[\s\S]*<\/ServerProvider>[\s\S]*<\/PrivacyConsentGate>/,
  );
  assert.match(consentGateSource, /同意并继续/);
  assert.match(consentGateSource, /拒绝并退出/);
  assert.match(consentGateSource, /@tauri-apps\/plugin-process/);
});
