import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { patchTauriOhosIdentifier } from '../scripts/patch-tauri-ohos-identifier.mjs';

test('Huawei OHOS identifier exception is narrow and repeatable', () => {
  const source = `  if config
    .identifier
    .chars()
    .any(|ch| !(ch.is_alphanumeric() || ch == '-' || ch == '.'))
  {`;
  const patched = patchTauriOhosIdentifier(source);
  assert.equal(patchTauriOhosIdentifier(patched), patched);
  assert.match(patched, /config\.identifier != "org\.houheya\.moke_openharmony"/);
  assert.match(patched, /ch\.is_alphanumeric\(\) \|\| ch == '-' \|\| ch == '\.'/);
});

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('official OHOS package identity and the signed release workflow remain aligned', () => {
  const stable = JSON.parse(read('src-tauri/tauri.conf.json'));
  const ohos = JSON.parse(read('src-tauri/tauri.ohos.conf.json'));
  assert.equal(stable.identifier, 'org.houheya.moke');
  assert.equal(ohos.identifier, 'org.houheya.moke_openharmony');
  const workflow = read('.github/workflows/build-release.yml');
  assert.match(workflow, /\.app\.bundleName == "org\.houheya\.moke_openharmony"/);
  assert.match(workflow, /node scripts\/patch-tauri-ohos-identifier\.mjs/);
  assert.match(workflow, /ohos init --config src-tauri\/tauri\.ohos\.conf\.json/);
  assert.match(workflow, /ohos build --config src-tauri\/tauri\.ohos\.conf\.json/);
  assert.match(workflow, /node scripts\/prepare-ohos-release\.mjs/);
  assert.match(workflow, /python3 scripts\/sign-ohos-release\.py/);
  assert.match(workflow, /files: ohos-release-artifacts\/\*\.hap/);
});
