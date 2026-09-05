import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const detail = readFileSync(new URL('../src/app/detail/page.tsx', import.meta.url), 'utf8');

test('book detail exposes online and offline actions separately', () => {
  assert.match(detail, /在线阅读/);
  assert.match(detail, /下载后阅读/);
  assert.match(detail, /离线阅读/);
  assert.match(detail, /resolveTalebookOnlineSource\(request, serverUrl, book\.id/);
  assert.match(detail, /filePath: source\.url/);
  assert.match(detail, /mokeSourceServerUrl: serverUrl/);
});

test('online opening does not enter the offline download manager', () => {
  const onlineStart = detail.indexOf('const handleOnlineRead');
  const offlineStart = detail.indexOf('const handleOfflineRead');
  assert.ok(onlineStart >= 0 && offlineStart > onlineStart);
  const onlineHandler = detail.slice(onlineStart, offlineStart);
  assert.doesNotMatch(onlineHandler, /startOfflineDownload|downloadAndSaveOfflineBook|saveOfflineBook/);
  assert.match(onlineHandler, /onlineReadingErrorMessage/);
});
