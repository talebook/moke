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
const downloadsSource = readSource('../src/app/downloads/page.tsx');
const appShellSource = readSource('../src/components/providers/AppShell.tsx');
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

test('下载目录从后端恢复且 Windows verbatim 前缀不会展示', () => {
  assert.match(appShellSource, /invoke<string \| null>\('moke_get_download_directory'\)/);
  assert.match(tauriSource, /download_directory_for_frontend/);
  assert.match(tauriSource, /strip_prefix/);
});

test('磁盘空间统计使用慢速轮询而非跟随下载进度刷新', () => {
  assert.match(downloadsSource, /STORAGE_STATS_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(downloadsSource, /\}, \[downloadDirectory\]\);/);
  assert.doesNotMatch(downloadsSource, /\[downloadDirectory, records, tasks\]/);
});
