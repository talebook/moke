import test from 'node:test';
import assert from 'node:assert/strict';
import { savedServerFocusHref, savedServerFocusId } from '../src/lib/saved-server-focus.ts';
import { useServerStore } from '../src/lib/store/server.ts';

test('cross-page handoff carries only a stable local id and selects an existing row', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('unexpected network'); });
  const active = useServerStore.getState();
  const entries = [{ id: 'local-A-123', url: 'https://a.example/team/books' }, { id: 'local-B-456', url: 'https://b.example' }];
  const before = structuredClone(entries);
  const href = savedServerFocusHref(entries[0].id);
  assert.equal(href, '/welcome?focusSaved=local-A-123');
  assert.equal(href.includes('https'), false);
  assert.equal(savedServerFocusId(new URL(href, 'http://ui.local').search, entries), 'local-A-123');
  assert.deepEqual(entries, before);
  assert.equal(useServerStore.getState(), active);
  assert.equal(requests, 0);
});

test('unknown and unsafe focus parameters never select or mint an id', () => {
  const entries = [{ id: 'local-safe' }];
  for (const search of ['', '?focusSaved=', '?focusSaved=unknown', '?focusSaved=https%3A%2F%2Fbooks.example',
    '?focusSaved=..%2Flocal-safe', '?focusSaved=local-safe%00', '?focusSaved=%3Cscript%3E',
    '?focusSaved=%23saved-local-safe', '?focusSaved=%E4%B9%A6%E5%BA%93', `?focusSaved=${'a'.repeat(129)}`]) {
    assert.equal(savedServerFocusId(search, entries), null, search);
  }
  assert.equal(savedServerFocusId('?url=https://books.example&grant=native-ticket', entries), null);
  assert.equal(savedServerFocusId('?focusSaved=local-safe', []), null);
});

test('focus URL creation preserves valid legacy identifiers without reinterpreting them', () => {
  for (const id of ['', 'a\nrow', '\u0000', '\ud800']) {
    assert.throws(() => savedServerFocusHref(id), /invalid-saved-id/, id);
  }
  for (const id of ['A', 'local-01-aB9', 'legacy_library_1', 'a b', '#row', '../row',
    'https://books.example', '书库', '<script>', 'a'.repeat(129)]) {
    const href = savedServerFocusHref(id);
    assert.equal(savedServerFocusId(href.slice(href.indexOf('?')), [{ id }]), id);
  }
});

test('URL-supplied addresses and authority-looking fields cannot change the row chosen by local id', () => {
  const entries = [{ id: 'existing', url: 'https://original.example/a', entryRevision: 'revision-1' }];
  const input = '?focusSaved=existing&url=https%3A%2F%2Fattacker.example&sessionId=forged&admissionId=forged';
  assert.equal(savedServerFocusId(input, entries), 'existing');
  assert.deepEqual(entries, [{ id: 'existing', url: 'https://original.example/a', entryRevision: 'revision-1' }]);
  assert.equal(savedServerFocusId('?focusSaved=missing&focusSaved=existing', entries), null);
});
