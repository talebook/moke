import assert from 'node:assert/strict';
import test from 'node:test';
import { tauriCommand } from '../scripts/tauri.mjs';

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
