import assert from 'node:assert/strict';
import test from 'node:test';
import { tauriCommand } from '../scripts/tauri.mjs';
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

test('OHOS dev explicitly loads the same stable platform config', () => {
  const { args } = tauriCommand(['ohos', 'dev']);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['ohos', 'dev', '--config', 'src-tauri/tauri.ohos.conf.json']);
});

test('OHOS retains the stable package identifier without a validator patch', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.ohos.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.identifier, 'org.houheya.moke');
});
