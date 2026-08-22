import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (relativePath) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const sidebarSource = readSource('../src/components/layout/Sidebar.tsx');
const tabBarSource = readSource('../src/components/layout/TabBar.tsx');
const settingsSource = readSource('../src/app/settings/page.tsx');
const tauriSource = readSource('../src-tauri/src/lib.rs');
const packageJson = JSON.parse(readSource('../package.json'));

test('下载管理仅保留设置入口，不占用侧边栏或底边栏', () => {
  assert.doesNotMatch(sidebarSource, /href:\s*['"]\/downloads['"]/);
  assert.doesNotMatch(tabBarSource, /href:\s*['"]\/downloads['"]/);
  assert.match(settingsSource, /href="\/downloads"/);
});

test('下载目录选择由 Tauri 后端打开系统对话框', () => {
  assert.doesNotMatch(settingsSource, /@tauri-apps\/plugin-dialog/);
  assert.match(settingsSource, /invoke<string \| null>\('moke_select_download_directory'\)/);
  assert.match(tauriSource, /async fn moke_select_download_directory/);
  assert.match(tauriSource, /blocking_pick_folder\(\)/);
  assert.equal(packageJson.dependencies['@tauri-apps/plugin-dialog'], undefined);
});
