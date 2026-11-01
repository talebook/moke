import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { useServerStore } from '../src/lib/store/server.ts';
import { markLegacyReaderAttempt } from '../src/lib/reader-source-guard.ts';
const { openEmbeddedReaderBook, openEmbeddedReaderHome } = await import('../src/lib/moke-reader.ts');
const { openOfflineBook, openBookWithSystemDefault } = await import('../src/lib/open-offline-book.ts');
const { canConnectSavedServer } = await import('../src/lib/saved-server-connection.ts');

test('managed library cannot dispatch embedded, home, offline or system Reader before source integration', async (t) => {
  const session = useServerStore.getState();
  assert.equal(session.activateSavedServer({ id: 'saved', url: 'https://books.example/a', entryRevision: 'r1' }, session.sessionRevision), true);
  let navigations = 0;
  const navigate = () => { navigations++; };
  t.mock.method(globalThis, 'fetch', () => assert.fail('Reader guard must precede network'));
  await assert.rejects(openEmbeddedReaderBook('/readest/reader?book=fixture', navigate), /saved-reader-source-unavailable/);
  await assert.rejects(openEmbeddedReaderHome({ eink: false, navigate }), /saved-reader-source-unavailable/);
  await assert.rejects(openOfflineBook({ id: 'fixture', serverUrl: 'https://old.example', bookId: '1', filePath: '/fixture.epub' }, navigate), /阅读功能暂未开放/);
  await assert.rejects(openBookWithSystemDefault('fixture'), /阅读功能暂未开放/);
  assert.equal(navigations, 0);
  useServerStore.getState().disconnect();
});

test('native sources and an unresolved legacy Reader attempt cannot be replaced by a new candidate', async () => {
  const previous = process.env.NEXT_PUBLIC_APP_PLATFORM;
  const entry = { id: 'next', url: 'https://new.example', entryRevision: 'r1', status: 'ready' };
  try {
    process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
    assert.equal(await canConnectSavedServer(entry), false);
    process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
    markLegacyReaderAttempt();
    assert.equal(await canConnectSavedServer(entry), false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previous;
  }
});
