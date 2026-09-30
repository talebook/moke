import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareOhosRelease, OHOS_RELEASE_BUNDLE } from '../scripts/prepare-ohos-release.mjs';

test('OHOS distribution identity preserves Preview label and all other app metadata', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ohos-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.json5');
  const original = { app: { bundleName: 'org.houheya.moke.preview', label: '$string:app_name', versionCode: 7 } };
  writeFileSync(file, JSON.stringify(original));
  prepareOhosRelease(file);
  prepareOhosRelease(file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    app: { ...original.app, bundleName: OHOS_RELEASE_BUNDLE },
  });
});

test('unexpected package identities are rejected without modifying the manifest', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ohos-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.json5');
  const original = JSON.stringify({ app: { bundleName: 'org.example.other' } });
  writeFileSync(file, original);
  assert.throws(() => prepareOhosRelease(file), /Unexpected OHOS package identity/);
  assert.equal(readFileSync(file, 'utf8'), original);
});
