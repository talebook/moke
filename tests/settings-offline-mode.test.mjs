import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/app/settings/page.tsx', import.meta.url)),
  'utf8',
);

test('设置页在离线书库区域进入 Moke 离线模式，不再打开 Readest 首页', () => {
  const offlineSection = source.indexOf('title="离线书库"');
  const appSection = source.indexOf('title="应用"');
  const offlineAction = source.indexOf('label="进入离线模式"');
  assert.ok(offlineSection >= 0);
  assert.ok(offlineAction > offlineSection && offlineAction < appSection);
  assert.match(source, /enterOfflineMode\(\);\s*router\.push\('\/shelf'\)/);
  assert.match(source, /<SettingsSection title="连接与数据"/);
  assert.match(source, /offlineMode\s*\?\s*\(\s*<ActionRow\s+icon=\{PlugZap\}\s+label="连接服务器"/);
  assert.match(source, /leaveOfflineMode\(\);\s*router\.push\('\/welcome'\)/);
  assert.match(source, /!offlineMode\s*&&\s*<ActionRow\s+icon=\{BookOpen\}\s+label="进入离线模式"/);
  assert.doesNotMatch(source, /返回离线书架/);
  assert.doesNotMatch(source, /openEmbeddedReaderHome|打开内嵌阅读器/);
});
