import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbeddedReaderUrl, isSingleWebviewRuntime } from '../src/lib/moke-reader.ts';

test('OHOS uses the single-WebView reader flow', () => {
  assert.equal(isSingleWebviewRuntime('ohos'), true);
  assert.equal(isSingleWebviewRuntime('android'), true);
  assert.equal(isSingleWebviewRuntime('ios'), true);
  assert.equal(isSingleWebviewRuntime('linux'), false);
  assert.equal(isSingleWebviewRuntime('windows'), false);
});

test('buildEmbeddedReaderUrl preserves the mobile reader launch context', () => {
  const url = new URL(
    buildEmbeddedReaderUrl({
      filePath: 'C:\\Users\\reader\\我的书.pdf',
      eink: true,
      mokeBookId: '14',
      serverUrl: 'http://192.168.1.5:8080',
      restoreProgress: {
        schema: 'moke.readest.progress.v1',
        reader: 'readest',
        moke_book_id: '14',
        location: 'page=142',
        updated_at: '2026-07-24T00:00:00.000Z',
      },
    }),
    'https://moke.invalid',
  );

  assert.equal(url.pathname, '/readest/reader');
  assert.equal(url.searchParams.get('file'), 'C:\\Users\\reader\\我的书.pdf');
  assert.equal(url.searchParams.get('moke'), '1');
  assert.equal(url.searchParams.get('mokeEink'), '1');
  assert.equal(url.searchParams.get('mokeBookId'), '14');
  assert.equal(url.searchParams.get('mokeServerUrl'), 'http://192.168.1.5:8080');
  assert.deepEqual(JSON.parse(url.searchParams.get('mokeRestoreProgress')), {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: '14',
    location: 'page=142',
    updated_at: '2026-07-24T00:00:00.000Z',
  });
});
