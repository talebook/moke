import assert from 'node:assert/strict';
import test from 'node:test';
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
