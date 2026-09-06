import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const detail = readFileSync(new URL('../src/app/detail/page.tsx', import.meta.url), 'utf8');

test('book detail exposes online and offline actions separately', () => {
  assert.match(detail, /在线阅读/);
  assert.match(detail, /下载后阅读/);
  assert.match(detail, /离线阅读/);
  assert.match(detail, /resolveTalebookOnlineSource\(\s*request,\s*serverUrl,\s*book\.id/);
  assert.match(detail, /isTauriApp \? tauriRangeFetch : request/);
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

test('primary actions keep the original width while download is a fixed icon button', () => {
  const groupStart = detail.indexOf('data-testid="book-primary-action-group"');
  const groupEnd = detail.indexOf('{!offlineMode && !onlineFormat &&', groupStart);
  assert.ok(groupStart >= 0 && groupEnd > groupStart);
  const group = detail.slice(groupStart, groupEnd);

  assert.match(group, /className="mt-5 flex h-11 w-full flex-nowrap items-stretch gap-2 md:mt-6 md:w-\[220px\]"/);
  assert.match(group, /data-testid="online-read-action"[\s\S]*?onClick=\{\(\) => void handleOnlineRead\(\)\}/);
  assert.match(group, /data-testid="online-read-action"[\s\S]*?className="[^"]*h-full min-w-0 flex-1[^"]*whitespace-nowrap/);
  assert.match(group, /data-testid="offline-download-action"[\s\S]*?onClick=\{\(\) => void \(downloaded \? handleOfflineRead\(\) : handleDownload\(\)\)\}/);
  assert.match(group, /aria-label=\{downloadActionLabel\}/);
  assert.match(group, /aria-busy=\{downloading \|\| \(openingReader && !openingOnline\)\}/);
  assert.match(group, /title=\{downloadActionLabel\}/);
  assert.match(group, /className=\{`[^`]*h-full w-11 shrink-0/);
  assert.match(group, /<Download className="h-4 w-4" \/>/);
  assert.match(group, /<Loader2 className="h-4 w-4 animate-spin" \/>/);
  assert.match(group, /<HardDrive className="h-4 w-4" \/>/);
  assert.match(group, /onlineFormat \? '在线阅读' : '暂不支持在线阅读'/);
  assert.doesNotMatch(group, /在线阅读\$\{bookFiles/);
});

test('offline mode exposes only the local primary action', () => {
  const actionsStart = detail.indexOf('{offlineMode ? (');
  const actionsEnd = detail.indexOf('{!offlineMode && !onlineFormat &&', actionsStart);
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
  const actions = detail.slice(actionsStart, actionsEnd);

  assert.match(actions, /data-testid="offline-read-primary-action"/);
  assert.match(actions, /onClick=\{\(\) => void handleOfflineRead\(\)\}/);
  assert.match(actions, /openingReader \? '打开中' : '离线阅读'/);
  assert.ok(actions.indexOf('offline-read-primary-action') < actions.indexOf('book-primary-action-group'));

  const handlerStart = detail.indexOf('const handleOfflineRead');
  const remoteBranch = detail.indexOf('const useSystemReader', handlerStart);
  const offlineHandler = detail.slice(handlerStart, remoteBranch);
  assert.match(offlineHandler, /if \(offlineMode\) \{/);
  assert.match(offlineHandler, /await openOfflineBook\(record, router\.push\)/);
  assert.doesNotMatch(offlineHandler, /resolveTalebookOnlineSource|recordBookRead|request\(/);
});
