import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const detailSource = readFileSync(
  fileURLToPath(new URL('../src/app/detail/page.tsx', import.meta.url)),
  'utf8',
);
const shelfSource = readFileSync(
  fileURLToPath(new URL('../src/app/shelf/page.tsx', import.meta.url)),
  'utf8',
);
const apiSource = readFileSync(
  fileURLToPath(new URL('../src/lib/api.ts', import.meta.url)),
  'utf8',
);

test('离线详情页只更新本地书架状态，不请求服务器接口', () => {
  const localBranch = detailSource.indexOf('if (offlineMode) {', detailSource.indexOf('const toggleShelf'));
  const remoteRequest = detailSource.indexOf('request(`${serverUrl}/api/book/${book.id}/shelf`', localBranch);
  assert.ok(localBranch >= 0 && remoteRequest > localBranch);
  assert.match(detailSource.slice(localBranch, remoteRequest), /setOfflineBookShelfState\(activeServerUrl/);
  assert.match(detailSource.slice(localBranch, remoteRequest), /return;/);
  assert.match(shelfSource, /records\.filter\(\(record\) => record\.inShelf === true\)/);
});

test('缺少服务器地址的诊断代码框使用 ASCII，规避 Turbopack 中文边界崩溃', () => {
  assert.match(apiSource, /Request rejected:.*missing absolute server URL/);
  assert.doesNotMatch(apiSource, /缺少服务器地址前缀/);
});
