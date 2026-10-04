import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const desktopConfigs = [
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.linux.conf.json',
  'src-tauri/tauri.macos.conf.json',
  'src-tauri/tauri.windows.conf.json',
];

test('desktop windows remain resizable without a minimum size', () => {
  for (const path of desktopConfigs) {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    for (const window of config.app?.windows ?? []) {
      assert.equal(window.resizable, true, `${path} must remain resizable`);
      assert.equal('minWidth' in window, false, `${path} must not set minWidth`);
      assert.equal('minHeight' in window, false, `${path} must not set minHeight`);
    }
  }

});
