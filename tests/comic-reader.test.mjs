import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBookReader, supportsComicPages } from '../src/lib/book-reader-policy.ts';
import { createComicApi, parseComicManifest, comicProgress, restoreComicPage, ComicProgressWriter } from '../src/lib/comic-api.ts';

const server = 'https://books.test';
const payload = () => ({ err: 'ok', contract_version: 1, book_id: 42, title: 'Comic', revision: 'abc-123', pages_count: 3,
  pages: [0, 1, 2].map(index => ({ id: `p${index}`, index, width: 800, height: 1100, mime_type: 'image/png',
    url: `https://evil.test/secret?token=must-not-be-used` })) });
const response = (url, data, status = 200, type = 'application/json') => {
  const r = new Response(type === 'application/json' ? JSON.stringify(data) : data, { status, headers: { 'content-type': type } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
};

test('explicit media type wins over conflicting formats; unknown/missing uses containers only', () => {
  for (const pref of ['embedded', 'system']) {
    for (const format of ['epub', 'pdf', 'cbz', 'cbr', 'zip', 'rar']) {
      assert.equal(resolveBookReader({ media_type: 'comic', files: [{ format }] }, pref), 'comic');
      assert.equal(resolveBookReader({ media_type: 'ebook', files: [{ format }] }, pref), pref);
    }
    for (const media_type of [undefined, 'unknown', 'future-type']) {
      assert.equal(resolveBookReader({ media_type, files: [{ format: ' CBZ ' }] }, pref), 'comic');
      for (const format of ['epub', 'pdf', 'txt']) assert.equal(resolveBookReader({ media_type, files: [{ format }] }, pref), pref);
    }
  }
  assert.equal(supportsComicPages({ media_type: 'comic', files: [{ format: 'epub' }] }), false);
  assert.equal(resolveBookReader({ media_type: 'comic' }, 'system'), 'comic');
});

test('manifest sorts pages but never preserves server URLs or bearer tokens', () => {
  const value = payload(); value.pages.reverse();
  const m = parseComicManifest(value, '42');
  assert.deepEqual(m.pages.map(p => p.id), ['p0', 'p1', 'p2']);
  assert.doesNotMatch(JSON.stringify(m), /evil|secret|token/);
  for (const change of [p => p.book_id++, p => p.pages_count++, p => p.pages[0].index = 8,
    p => p.pages[1].id = 'p0', p => p.pages[0].mime_type = 'image/svg+xml', p => p.revision = '../escape',
    p => p.pages[0].width = 0]) {
    const invalid = payload(); change(invalid);
    assert.throws(() => parseComicManifest(invalid, '42'));
  }
});

test('progress restores by page id, clamps stale indices, and normalizes percent/completion', () => {
  const m = parseComicManifest(payload(), '42');
  assert.equal(restoreComicPage(m, { ...comicProgress(m, 1), pageIndex: 0 }), 1);
  assert.equal(restoreComicPage(m, { kind: 'comic', version: 1, pageIndex: 900 }), 2);
  assert.equal(restoreComicPage(m, { pageIndex: 2 }), 0);
  assert.deepEqual(comicProgress(m, 99), { kind: 'comic', version: 1, pageId: 'p2', pageIndex: 2, percent: 100, completed: true });
});

test('host requests only fixed book paths, rejects redirects/MIME/errors, and keeps tokens out', async () => {
  const calls = [];
  const api = createComicApi(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/pages')) return response(url, payload());
    return response(url, new Uint8Array([1, 2, 3]), 200, 'image/png');
  }, server, '42', new AbortController().signal);
  const m = await api.manifest();
  assert.equal((await api.page(m, 1)).size, 3);
  assert.equal(calls[1].url, `${server}/api/book/42/comic/pages/1?revision=abc-123`);
  assert.equal(calls[1].init.maxRedirections, 0);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.credentials, 'include');
  for (const status of [401, 403, 404, 409, 500]) {
    const bad = createComicApi(async url => response(url, {}, status), server, '42', new AbortController().signal);
    await assert.rejects(bad.manifest(), new RegExp(String(status)));
  }
  for (const handler of [async () => response('https://evil.test', payload()),
    async url => response(url, '<html/>', 200, 'text/html'),
    async url => response(url, { err: 'comic.no_permission' })]) {
    await assert.rejects(createComicApi(handler, server, '42', new AbortController().signal).manifest());
  }
  const badImage = createComicApi(async url => response(url, '<svg/>', 200, 'image/svg+xml'), server, '42', new AbortController().signal);
  await assert.rejects(badImage.page(m, 0));
  await assert.rejects(api.page(m, -1));
  assert.throws(() => createComicApi(fetch, server, '../2', new AbortController().signal));
});

test('progress writes serialize and coalesce; failure cannot overwrite a newer queued page', async () => {
  const m = parseComicManifest(payload(), '42');
  const saved = [];
  let reject;
  const writer = new ComicProgressWriter(async p => {
    saved.push(p.pageIndex);
    if (saved.length === 1) await new Promise((_, fail) => { reject = fail; });
  });
  writer.queue(comicProgress(m, 0));
  const first = writer.flush();
  writer.queue(comicProgress(m, 1)); writer.queue(comicProgress(m, 2));
  reject(new Error('network'));
  await assert.rejects(first);
  await writer.flush();
  assert.deepEqual(saved, [0, 2]);
});

test('cancelling comic open rejects a stalled native request', async () => {
  const controller = new AbortController();
  const api = createComicApi(() => new Promise(() => {}), server, '42', controller.signal);
  const loading = api.manifest(); controller.abort();
  await assert.rejects(loading, { name: 'AbortError' });
});
