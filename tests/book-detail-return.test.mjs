import test from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_RETURN_KEY, DETAIL_RETURN_MAX_AGE, saveDetailReturn, takeDetailReturn } from '../src/lib/book-detail-return.ts';
import { resolveBookReader } from '../src/lib/book-reader-policy.ts';

const identity = { serverUrl: 'https://books.test', accountId: '1', bookId: '42', offlineMode: true, source: 'https://source.test' };
const snapshot = { book: { id: '42', title: '测试书籍', files: [{ format: 'epub', size: 100 }] }, selectedFormat: 'epub', inShelf: true, downloaded: true };
const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};

test('a matching history return restores display metadata once', () => {
  const storage = memoryStorage();
  assert.equal(saveDetailReturn(identity, snapshot, 'entry', storage, 1000), true);
  assert.deepEqual(JSON.parse(JSON.stringify(takeDetailReturn(identity, 'entry', storage, 2000))), snapshot);
  assert.equal(takeDetailReturn(identity, 'entry', storage, 2000), null);
});

test('return metadata preserves explicit comic classification and ebook overrides', () => {
  for (const [media_type, format, reader] of [['comic', 'pdf', 'comic'], ['ebook', 'cbz', 'embedded']]) {
    const storage = memoryStorage();
    const book = { ...snapshot.book, media_type, files: [{ format, size: 100 }] };
    assert.equal(saveDetailReturn(identity, { ...snapshot, book, selectedFormat: format }, 'entry', storage, 1000), true);
    const restored = takeDetailReturn(identity, 'entry', storage, 2000);
    assert.equal(restored.book.media_type, media_type);
    assert.equal(resolveBookReader(restored.book, 'embedded'), reader);
  }
});

test('return metadata is isolated by server, account, book, mode, source and history entry', () => {
  for (const change of [{ serverUrl: 'https://other.test' }, { accountId: '2' }, { accountId: 'guest' }, { bookId: '99' }, { offlineMode: false }, { source: '' }]) {
    const storage = memoryStorage();
    saveDetailReturn(identity, snapshot, 'entry', storage, 1000);
    assert.equal(takeDetailReturn({ ...identity, ...change }, 'entry', storage, 2000), null);
    assert.equal(storage.getItem(DETAIL_RETURN_KEY), null);
  }
  for (const token of [undefined, null, 'fresh-link']) {
    const storage = memoryStorage();
    saveDetailReturn(identity, snapshot, 'entry', storage, 1000);
    assert.equal(takeDetailReturn(identity, token, storage, 2000), null);
  }
});

test('expired, future, malformed and oversized snapshots fall back to live loading', () => {
  for (const now of [999, 1001 + DETAIL_RETURN_MAX_AGE]) {
    const storage = memoryStorage();
    saveDetailReturn(identity, snapshot, 'entry', storage, 1000);
    assert.equal(takeDetailReturn(identity, 'entry', storage, now), null);
  }
  const storage = memoryStorage();
  storage.setItem(DETAIL_RETURN_KEY, '{bad json');
  assert.equal(takeDetailReturn(identity, 'entry', storage, 2000), null);
  saveDetailReturn(identity, snapshot, 'entry', storage, 1000);
  const broken = JSON.parse(storage.getItem(DETAIL_RETURN_KEY));
  broken.snapshot.book.files = [{ format: {} }];
  storage.setItem(DETAIL_RETURN_KEY, JSON.stringify(broken));
  assert.equal(takeDetailReturn(identity, 'entry', storage, 2000), null);
  assert.equal(saveDetailReturn(identity, { ...snapshot, book: { ...snapshot.book, comments: 'x'.repeat(200 * 1024) } }, 'entry', storage, 1000), false);
});

test('storage failures do not break reading or detail loading', () => {
  const storage = { getItem: () => { throw new Error('unavailable'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
  assert.equal(saveDetailReturn(identity, snapshot, 'entry', storage), false);
  assert.equal(takeDetailReturn(identity, 'entry', storage), null);
});

test('only display fields persist; native paths, credentials and progress are excluded', () => {
  const storage = memoryStorage();
  const book = { ...snapshot.book, filePath: '/private/book.epub', token: 'secret', progress: 0.4,
    authors: [{ name: '作者', token: 'secret' }], files: [{ format: 'epub', size: 100, filePath: '/private/book.epub' }],
    img: 'blob:expired', thumb: 'https://books.test/cover/42?token=secret' };
  saveDetailReturn(identity, { ...snapshot, book }, 'entry', storage, 1000);
  const raw = storage.getItem(DETAIL_RETURN_KEY);
  assert.doesNotMatch(raw, /secret|filePath|progress|blob:/);
  const result = takeDetailReturn(identity, 'entry', storage, 2000);
  assert.equal(result.book.thumb, 'https://books.test/cover/42');
  assert.deepEqual(result.book.authors, ['作者']);
});


test('relative signed covers and external credential URLs are not retained', () => {
  const storage = memoryStorage();
  saveDetailReturn(identity, { ...snapshot, book: { ...snapshot.book,
    img: '/cover/42?token=secret', thumb: 'https://name:secret@books.test/cover' } }, 'entry', storage, 1000);
  const raw = storage.getItem(DETAIL_RETURN_KEY);
  assert.doesNotMatch(raw, /secret|name:/);
  const result = takeDetailReturn(identity, 'entry', storage, 2000);
  assert.equal(result.book.img, '/cover/42');
  assert.equal(result.book.thumb, undefined);
});
