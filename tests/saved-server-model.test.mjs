import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVED_SERVER_SCHEMA_VERSION,
  migrateSavedServerRegistry,
  parseSavedServerRegistry,
  serializeSavedServerRegistry,
  recomputeSavedServerCollisions,
  validateDisplayName,
  parseDisplayName,
} from '../src/lib/saved-server-model.ts';

const NOW = '2026-11-01T12:00:00.000Z';
function dependencies() {
  let next = 0;
  return { createId: () => `generated-${++next}`, now: () => NOW };
}
function migrate(state, urlRaw = null, factory = dependencies()) {
  return migrateSavedServerRegistry({ stateRaw: state === null ? null : JSON.stringify(state), urlRaw }, factory);
}
function legacyList(records, urlRaw = null) {
  return migrate({ version: 1, state: { savedServers: records } }, urlRaw);
}

test('migrates old single-server state without treating its credentials as runtime list fields', () => {
  const state = {
    serverUrl: 'https://books.example', serverTitle: 'My library',
    token: 'synthetic-old-token', user: { id: 17 }, offlineDirectory: 'books/original',
    nested: { futureMetadata: ['keep', 42] },
  };
  const original = { version: 0, state, futureTopLevel: { keep: true } };
  const registry = migrate(original);
  assert.equal(registry.version, SAVED_SERVER_SCHEMA_VERSION);
  assert.equal(registry.savedServers.length, 1);
  const entry = registry.savedServers[0];
  assert.equal(entry.url, state.serverUrl);
  assert.equal(entry.title, state.serverTitle);
  assert.equal(entry.status, 'ready');
  assert.equal(entry.addedAt, NOW);
  assert.equal('token' in entry, false);
  assert.equal('user' in entry, false);
  assert.deepEqual(entry.originals, [{ source: 'moke-server-storage', index: null, rawUrl: state.serverUrl, record: state }]);
  assert.equal(registry.legacySources.stateRaw, JSON.stringify(original));
});

test('single-server compatibility mirror adds an original and alias, never a second identity', () => {
  const registry = migrate({ version: 0, state: { serverUrl: 'HTTPS://Books.Example:443/' } }, ' https://books.example/// ');
  assert.equal(registry.savedServers.length, 1);
  const [entry] = registry.savedServers;
  assert.equal(entry.url, 'https://books.example');
  assert.equal(entry.status, 'ready');
  assert.deepEqual(entry.legacyAliases, ['HTTPS://Books.Example:443/', ' https://books.example/// ']);
  assert.equal(entry.originals[1].source, 'moke_server_url');
  assert.equal(entry.originals[1].record, ' https://books.example/// ');
});

test('A, B and same-origin prefixes retain individual stable legacy IDs and metadata', () => {
  const records = [
    { id: 'a', url: 'https://books.example/a', title: 'A', addedAt: 'old-a', custom: { order: 7 } },
    { id: 'b', url: 'https://books.example/b', title: 'B', addedAt: 'old-b', downloadId: 'unchanged' },
    { id: 'other', url: 'http://192.168.1.20:8080', custom: { array: [false, null] } },
  ];
  const registry = legacyList(records);
  assert.deepEqual(registry.savedServers.map((entry) => [entry.id, entry.url, entry.status]), records.map((entry) => [entry.id, entry.url, 'ready']));
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].record), records);
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].index), [0, 1, 2]);
  assert.equal(registry.savedServers[0].addedAt, 'old-a');
});

test('equivalent addresses preserve both records as explicit collisions, including their own credentials', () => {
  const records = [
    { id: 'first', url: 'https://books.example/a', token: 'synthetic-a', order: 1 },
    { id: 'second', url: 'HTTPS://BOOKS.EXAMPLE:443/a/', token: 'synthetic-b', order: 2 },
  ];
  const registry = legacyList(records);
  assert.deepEqual(registry.savedServers.map((entry) => entry.status), ['collision', 'collision']);
  assert.deepEqual(registry.savedServers.map((entry) => entry.id), ['first', 'second']);
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].record), records);
  assert.equal(registry.savedServers[1].legacyAliases[0], records[1].url);
  const separated = recomputeSavedServerCollisions([
    registry.savedServers[0], { ...registry.savedServers[1], url: 'https://books.example/b' },
  ]);
  assert.deepEqual(separated.map((entry) => entry.status), ['ready', 'ready']);
  assert.deepEqual(registry.savedServers.map((entry) => entry.status), ['collision', 'collision']);
});

test('every malformed v1 row survives with its exact value and source position', () => {
  const records = [null, 0, 'legacy row', { url: 17, id: 'number' },
    { id: 'missing', custom: { keep: true } }, { id: 'invalid', url: 'books.example/a', nested: [1, 2] }];
  const registry = legacyList(records);
  assert.equal(registry.savedServers.length, records.length);
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].record), records);
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].index), records.map((_, index) => index));
  assert.ok(registry.savedServers.every((entry) => entry.status === 'needs-edit'));
  assert.equal(registry.savedServers.at(-1).url, 'books.example/a');
  assert.equal(registry.savedServers[3].originals[0].rawUrl, 17);
  assert.equal(new Set(registry.savedServers.map((entry) => entry.id)).size, records.length);
});

test('duplicate legacy IDs are preserved archivally but receive unique local identities and require correction', () => {
  const registry = legacyList([
    { id: 'same', url: 'http://books.example/a' },
    { id: 'same', url: 'http://books.example/b' },
  ]);
  assert.equal(registry.savedServers[0].id, 'same');
  assert.notEqual(registry.savedServers[1].id, 'same');
  assert.ok(registry.savedServers.every((entry) => entry.status === 'needs-edit' && entry.issue === 'duplicate-legacy-id'));
  assert.deepEqual(registry.savedServers.map((entry) => entry.originals[0].record.id), ['same', 'same']);
});

test('generated IDs cannot steal an original ID appearing later in the list', () => {
  const candidates = ['existing-later', 'new-id', 'new-revision', 'second-revision'];
  const registry = legacyListWithFactory([
    { url: 'http://books.example/a' }, { id: 'existing-later', url: 'http://books.example/b' },
  ], { createId: () => candidates.shift(), now: () => NOW });
  assert.deepEqual(registry.savedServers.map((entry) => entry.id), ['new-id', 'existing-later']);
});

function legacyListWithFactory(records, factory) {
  return migrate({ version: 1, state: { savedServers: records } }, null, factory);
}

test('historical root adapter never guesses a missing protocol or erases an unsafe path', () => {
  const urls = [
    ' http://books.example:80/// ', 'http://books.example/a/..', 'books.example',
    'http://u:p@books.example/', 'http://books.example/?', 'http://books.example/#',
    'http://books.example/%2e', 'http://books.example\\', 'http://books.example/a//',
    'http://192.168.1', 'http://books.example\n.evil',
  ];
  const registry = legacyList(urls.map((url, index) => ({ id: `row-${index}`, url })));
  assert.equal(registry.savedServers[0].url, 'http://books.example');
  assert.equal(registry.savedServers[0].status, 'ready');
  for (let index = 1; index < urls.length; index++) {
    assert.equal(registry.savedServers[index].status, 'needs-edit', urls[index]);
    assert.equal(registry.savedServers[index].originals[0].rawUrl, urls[index]);
    assert.equal(registry.savedServers[index].url, urls[index]);
  }
});

test('migration keeps valid IDNA/public/long manual bases without applying discovery wire limits', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('unexpected network'); };
  try {
    const longUrl = `https://books.example/${'library/'.repeat(40)}books`;
    const registry = legacyList([
      { id: 'idna', url: 'https://书库.example/team/books' },
      { id: 'public', url: 'https://8.8.8.8/a' }, { id: 'long', url: longUrl },
    ]);
    assert.equal(registry.savedServers[0].url, 'https://xn--1jq370b.example/team/books');
    assert.equal(registry.savedServers[2].url, longUrl);
    assert.ok(registry.savedServers.every((entry) => entry.status === 'ready'));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('malformed legacy documents and invalid list containers remain correctable without dropping raw bytes', () => {
  for (const stateRaw of ['{invalid json', 'null', '[]', '{"version":1,"state":{"savedServers":{"unexpected":true}}}']) {
    const registry = migrateSavedServerRegistry({ stateRaw, urlRaw: null }, dependencies());
    assert.equal(registry.legacySources.stateRaw, stateRaw);
    assert.equal(registry.savedServers.length, 1);
    assert.equal(registry.savedServers[0].status, 'needs-edit');
    assert.equal(registry.savedServers[0].originals[0].source, 'moke-server-storage');
    assert.equal(registry.savedServers[0].originals[0].index, null);
    assert.equal(parseSavedServerRegistry(serializeSavedServerRegistry(registry)).legacySources.stateRaw, stateRaw);
  }
});

test('empty initial configuration is not a fake server and distinct old sources are both retained', () => {
  assert.equal(migrate(null).savedServers.length, 0);
  assert.equal(migrate({ version: 0, state: { serverUrl: '', token: '' } }, '').savedServers.length, 0);
  const registry = migrate({ version: 0, state: { serverUrl: 'http://books.example/a' } }, 'http://books.example/b');
  assert.deepEqual(registry.savedServers.map((entry) => entry.url), ['http://books.example/a', 'http://books.example/b']);
  assert.equal(registry.savedServers[1].originals[0].source, 'moke_server_url');
});

test('persisted v2 round-trip keeps IDs, revisions, originals, raw sources and future metadata unchanged', () => {
  const registry = legacyList([{ id: 'existing', url: 'https://books.example:443/', arbitrary: { settings: 1 } }]);
  registry.futureMetadata = { preserved: true };
  registry.savedServers[0].futureEntryMetadata = ['unchanged'];
  const encoded = serializeSavedServerRegistry(registry);
  const decoded = parseSavedServerRegistry(encoded);
  assert.deepEqual(decoded, registry);
  assert.equal(serializeSavedServerRegistry(decoded), encoded);
  assert.equal(decoded.savedServers[0].id, 'existing');
  assert.equal(decoded.savedServers[0].entryRevision, registry.savedServers[0].entryRevision);
});

test('unknown schemas fail closed instead of migrating or serializing a replacement', () => {
  for (const version of [2, 3, -1, '1', null]) {
    assert.throws(() => migrate({ version, state: { serverUrl: 'https://books.example' } }), { message: 'unsupported-legacy-schema' });
  }
  for (const version of [0, 1, 3, '2', null]) {
    assert.throws(() => parseSavedServerRegistry(JSON.stringify({ version, savedServers: [], legacySources: { stateRaw: null, urlRaw: null } })), { message: 'unsupported-saved-server-schema' });
  }
});

test('strict v2 validation refuses broken originals, duplicate IDs, forged statuses and uncanonical ready URLs', () => {
  const original = legacyList([{ id: 'existing', url: 'https://books.example/a' }]);
  const modifications = [
    (registry) => { delete registry.legacySources; },
    (registry) => { registry.legacySources.urlRaw = 123; },
    (registry) => { delete registry.savedServers[0].originals; },
    (registry) => { delete registry.savedServers[0].originals[0].record; },
    (registry) => { registry.savedServers[0].originals[0].index = -1; },
    (registry) => { registry.savedServers.push({ ...registry.savedServers[0] }); },
    (registry) => { registry.savedServers[0].status = 'collision'; },
    (registry) => { registry.savedServers[0].url += '/'; },
    (registry) => { registry.savedServers[0].displayName = 'bad\nname'; },
  ];
  for (const modify of modifications) {
    const registry = structuredClone(original);
    modify(registry);
    assert.throws(() => parseSavedServerRegistry(JSON.stringify(registry)), { message: 'invalid-saved-server-schema' });
  }
});

test('serialization refuses non-JSON metadata instead of silently erasing original data', () => {
  for (const invalid of [undefined, NaN, Infinity, 1n, () => {}, new Date()]) {
    const registry = legacyList([{ id: 'existing', url: 'http://books.example' }]);
    registry.savedServers[0].originals[0].record = { invalid };
    assert.throws(() => serializeSavedServerRegistry(registry), { message: 'invalid-saved-server-schema' });
  }
  const registry = migrate(null);
  registry.circular = registry;
  assert.throws(() => serializeSavedServerRegistry(registry), { message: 'invalid-saved-server-schema' });
});

test('display hints have a deterministic 128 Unicode code-point limit and reject controls and lone surrogates', () => {
  assert.equal(parseDisplayName(''), '');
  assert.equal(parseDisplayName('  Keep spelling  '), '  Keep spelling  ');
  assert.equal(validateDisplayName('📚'.repeat(128)), true);
  assert.equal(validateDisplayName('📚'.repeat(129)), false);
  for (const value of ['a\nb', '\u0000', '\u0085', '\ud800', null, 7]) {
    assert.equal(validateDisplayName(value), false);
    assert.throws(() => parseDisplayName(value), { message: 'invalid-display-name' });
  }
  const registry = legacyList([{ id: 'old', url: 'http://books.example/a', displayName: 'old\nname', title: 'keep title' }]);
  assert.equal(registry.savedServers[0].status, 'needs-edit');
  assert.equal(registry.savedServers[0].issue, 'invalid-display-name');
  assert.equal(registry.savedServers[0].originals[0].record.displayName, 'old\nname');
  assert.equal(registry.savedServers[0].title, 'keep title');
});
