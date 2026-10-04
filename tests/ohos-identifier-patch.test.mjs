import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('OHOS stable keeps the existing application identity and the HAP assertion agrees', () => {
  const stable = JSON.parse(read('src-tauri/tauri.conf.json'));
  const ohos = JSON.parse(read('src-tauri/tauri.ohos.conf.json'));
  assert.equal(stable.identifier, 'org.houheya.moke');
  assert.equal(ohos.identifier, stable.identifier);
  // Same character constraint as the pinned CLI: the stable identity needs no patch.
  assert.match(ohos.identifier, /^[a-zA-Z0-9.-]+$/);
  const workflow = read('.github/workflows/build-release.yml');
  assert.match(workflow, /\.app\.bundleName == "org\.houheya\.moke"/);
  assert.doesNotMatch(workflow, /patch-tauri-ohos-identifier|moke_openharmony/);
  assert.match(workflow, /ohos init --config src-tauri\/tauri\.ohos\.conf\.json/);
  assert.match(workflow, /ohos build --config src-tauri\/tauri\.ohos\.conf\.json/);
});

test('stable does not mutate the vendored CLI identifier validator', () => {
  assert.equal(existsSync(new URL('../scripts/patch-tauri-ohos-identifier.mjs', import.meta.url)), false);
});
