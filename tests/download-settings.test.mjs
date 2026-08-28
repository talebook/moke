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
const offlineBooksSource = readSource('../src/lib/offline-books.ts');
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

test('移动端不会编译仅桌面可用的目录选择器', () => {
  assert.match(
    tauriSource,
    /#\[cfg\(any\(target_env = "ohos", mobile\)\)\][\s\S]*?custom download directory is not supported on this platform/,
  );
  assert.match(
    tauriSource,
    /#\[cfg\(not\(any\(target_env = "ohos", mobile\)\)\)\][\s\S]*?blocking_pick_folder\(\)/,
  );
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

test('已完成下载不再显示进度条和 100% 的传输明细', () => {
  assert.match(downloadsSource, /item\.status !== 'completed' \? \(/);
  assert.match(downloadsSource, /文件大小 \{formatBytes\(item\.record\?\.size \?\? item\.downloadedBytes\)\}/);
});

test('删除下载文件优先使用受原生索引约束的路径', () => {
  assert.match(tauriSource, /fn moke_delete_downloaded_book_file/);
  assert.match(tauriSource, /find\(\|book\| book\.id == id\)/);
  assert.match(tauriSource, /moke_delete_downloaded_book_file,/);
  assert.match(offlineBooksSource, /invoke\('moke_delete_downloaded_book_file', \{ id: record\.id \}\)/);
  assert.doesNotMatch(tauriSource, /fn moke_delete_downloaded_book_file\([^)]*path:\s*String/);
});

test('打开和定位下载文件不向主窗口开放任意 opener 路径', () => {
  const mainCapability = JSON.parse(readSource('../src-tauri/capabilities/default.json'));
  assert.ok(!mainCapability.permissions.includes('opener:allow-open-path'));
  assert.match(tauriSource, /fn moke_open_downloaded_book/);
  assert.match(tauriSource, /fn moke_reveal_downloaded_book/);
  assert.match(downloadsSource, /invoke\('moke_reveal_downloaded_book', \{ id: item\.record\.id \}\)/);
});
