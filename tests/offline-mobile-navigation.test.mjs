import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/components/layout/TabBar.tsx', import.meta.url)),
  'utf8',
);
const shelfSource = readFileSync(
  fileURLToPath(new URL('../src/app/shelf/page.tsx', import.meta.url)),
  'utf8',
);
const settingsSource = readFileSync(
  fileURLToPath(new URL('../src/app/settings/page.tsx', import.meta.url)),
  'utf8',
);

test('移动端离线模式用设置替换需要服务器的“我的”标签', () => {
  assert.match(source, /offlineMode\s*\?\s*\{ href: '\/settings', icon: Settings, label: '设置' \}/);
  assert.match(source, /:\s*\{ href: '\/user', icon: User, label: '我的' \}/);
  assert.match(source, /useServerStore\(\(state\) => state\.offlineMode\)/);
  assert.match(source, /<Link[\s\S]*?replace[\s\S]*?href=\{tab\.href\}/);
  assert.match(shelfSource, /!offlineMode\s*&&\s*<Link\s+href="\/user\/history"/);
  assert.match(settingsSource, /!offlineMode\s*&&\s*user\s*&&/);
});
