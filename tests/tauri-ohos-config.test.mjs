import assert from 'node:assert/strict';
import test from 'node:test';
import { tauriCommand } from '../scripts/tauri.mjs';
import { patchTauriOhosIdentifier } from '../scripts/patch-tauri-ohos-identifier.mjs';
import { readFileSync } from 'node:fs';

test('OHOS init and build always load the OHOS identity config', () => {
  for (const subcommand of ['init', 'build']) {
    const { args } = tauriCommand(['ohos', subcommand, '--target', 'aarch64']);
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [
      'ohos', subcommand, '--config', 'src-tauri/tauri.ohos.conf.json', '--target', 'aarch64',
    ]);
  }
});

test('additional OHOS config can override the default flavor', () => {
  const { args } = tauriCommand(['ohos', 'build', '--config', 'custom.json']);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [
    'ohos', 'build', '--config', 'src-tauri/tauri.ohos.conf.json', '--config', 'custom.json',
  ]);
});

test('OHOS dev retains its platform auto configuration', () => {
  const { args } = tauriCommand(['ohos', 'dev']);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['ohos', 'dev']);
});

test('the Huawei identifier patch is narrow and repeatable', () => {
  const source = readFileSync(new URL('../vendor/tauri/crates/tauri-cli/src/build.rs', import.meta.url), 'utf8');
  const patched = patchTauriOhosIdentifier(source);
  assert.equal(patchTauriOhosIdentifier(patched), patched);
  assert.match(patched, /config\.identifier != "org\.houheya\.moke_openharmony"/);
  assert.match(patched, /ch\.is_alphanumeric\(\) \|\| ch == '-' \|\| ch == '\.'/);
});
