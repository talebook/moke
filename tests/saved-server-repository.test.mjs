import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedServerRepository, SAVED_SERVER_STORAGE_KEY } from '../src/lib/saved-server-repository.ts';
import { parseSavedServerRegistry, serializeSavedServerRegistry } from '../src/lib/saved-server-model.ts';

const KEY = SAVED_SERVER_STORAGE_KEY;
const NOW = '2026-11-01T08:00:00.000Z';
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const values = new Map(options.authority === undefined ? [] : [[KEY, options.authority]]);
  const sources = { stateRaw: null, urlRaw: null, ...options.sources };
  const calls = [];
  const hooks = {};
  let sequence = 0;
  let idCalls = 0;
  const storage = {
    async getItem(key) {
      await Promise.resolve();
      calls.push(['get', key]);
      const raw = values.get(key) ?? null;
      return hooks.get ? hooks.get(key, raw) : raw;
    },
    async setItem(key, raw) {
      await Promise.resolve();
      calls.push(['set', key]);
      await hooks.beforeSet?.(key, raw);
      values.set(key, raw);
      await hooks.afterSet?.(key, raw);
    },
  };
  const repositoryOptions = {
    async readLegacySources() {
      await Promise.resolve();
      return hooks.sources ? hooks.sources() : { ...sources };
    },
    createId() { idCalls++; return `generated-${++sequence}`; },
    now: () => NOW,
    isEntryInUse: options.isEntryInUse ?? (() => false),
  };
  const repository = new SavedServerRepository(storage, repositoryOptions);
  return { values, sources, calls, hooks, storage, repositoryOptions, repository,
    idCalls: () => idCalls,
    authority: () => values.get(KEY),
    writes: () => calls.filter(([operation]) => operation === 'set'),
  };
}

async function loaded(options) {
  const f = fixture(options);
  assert.equal((await f.repository.load()).ok, true);
  f.calls.length = 0;
  return f;
}

function successful(result, outcome) {
  assert.equal(result.ok, true);
  assert.equal(result.outcome, outcome);
  assert.equal(result.persisted, true);
  return result.server;
}

function failed(result, outcome) {
  assert.equal(result.ok, false);
  assert.equal(result.outcome, outcome);
  return result;
}

test('saving A and B persists both, returns stable IDs, and equivalent spelling is read-only existing', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const f = await loaded();
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'HTTPS://A.Example:443/', displayName: 'A' }), 'created');
  const b = successful(await f.repository.saveServer({ rawBaseUrl: 'https://b.example' }), 'created');
  assert.notEqual(a.id, b.id);
  assert.equal(a.url, 'https://a.example');
  assert.equal(a.addedAt, NOW);
  const raw = f.authority();
  const writes = f.writes().length;
  const ids = f.idCalls();
  const again = successful(await f.repository.saveServer({ rawBaseUrl: 'https://a.example', displayName: 'ignored replacement' }), 'existing');
  assert.equal(again.id, a.id);
  assert.equal(again.displayName, 'A');
  assert.equal(again.entryRevision, a.entryRevision);
  assert.equal(f.authority(), raw);
  assert.equal(f.writes().length, writes);
  assert.equal(f.idCalls(), ids);
  const reloaded = new SavedServerRepository(f.storage, f.repositoryOptions);
  assert.equal((await reloaded.load()).ok, true);
  assert.deepEqual(reloaded.getSnapshot().savedServers.map(({ id, url }) => ({ id, url })), [
    { id: a.id, url: 'https://a.example' }, { id: b.id, url: 'https://b.example' },
  ]);
});

test('the unique parser keeps IDNA, long manual URLs and /a versus /b identities', async () => {
  const f = await loaded();
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://书库.example/a/' }), 'created');
  const duplicate = successful(await f.repository.saveServer({ rawBaseUrl: 'https://xn--1jq370b.example/a' }), 'existing');
  const b = successful(await f.repository.saveServer({ rawBaseUrl: 'https://书库.example/b' }), 'created');
  assert.equal(a.id, duplicate.id);
  assert.notEqual(a.id, b.id);
  const longUrl = `https://public.example/${'a'.repeat(240)}`;
  assert.equal(successful(await f.repository.saveServer({ rawBaseUrl: longUrl }), 'created').url, longUrl);
  assert.equal(f.repository.getSnapshot().savedServers.length, 3);
});

test('invalid new URL and display names keep authoritative state and caller drafts unchanged', async () => {
  const f = await loaded();
  const before = f.authority();
  for (const rawBaseUrl of ['books.example', ' https://books.example', 'https://books.example/a/../b', 'https://books.example?']) {
    const draft = { rawBaseUrl };
    failed(await f.repository.saveServer(draft), 'needs-edit');
    assert.equal(draft.rawBaseUrl, rawBaseUrl);
  }
  for (const displayName of ['a\nname', 'a\u0000name', '\ud800', 'x'.repeat(129)]) {
    const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example', displayName }), 'needs-edit');
    assert.equal(result.code, 'invalid-display-name');
  }
  assert.equal(f.authority(), before);
  assert.deepEqual(f.writes(), []);
});

test('explicit address correction keeps ID/history and rejects missing, stale, colliding or in-use targets', async () => {
  let used = false;
  const f = await loaded({ isEntryInUse: () => used });
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://a.example/a' }), 'created');
  const b = successful(await f.repository.saveServer({ rawBaseUrl: 'https://b.example/b' }), 'created');
  const before = f.authority();
  const target = { id: a.id, expectedEntryRevision: a.entryRevision };
  assert.equal(failed(await f.repository.saveServer({ rawBaseUrl: 'https://next.example', target: { ...target, id: 'missing' } }), 'entry-not-found').entryId, 'missing');
  assert.equal(failed(await f.repository.saveServer({ rawBaseUrl: 'https://next.example', target: { ...target, expectedEntryRevision: 'stale' } }), 'entry-changed').entryId, a.id);
  const collision = failed(await f.repository.saveServer({ rawBaseUrl: b.url, target }), 'collision');
  assert.deepEqual(new Set(collision.entryIds), new Set([a.id, b.id]));
  used = true;
  failed(await f.repository.saveServer({ rawBaseUrl: 'https://next.example', target }), 'entry-in-use');
  assert.equal(f.authority(), before);
  used = false;
  const corrected = successful(await f.repository.saveServer({ rawBaseUrl: 'https://next.example/prefix', target }), 'corrected');
  assert.equal(corrected.id, a.id);
  assert.equal(corrected.addedAt, a.addedAt);
  assert.notEqual(corrected.entryRevision, a.entryRevision);
  assert.equal(corrected.originals.at(-1).source, 'correction');
  assert.equal(corrected.originals.at(-1).rawUrl, a.url);
  const { originals: priorOriginals, ...previousRecord } = a;
  assert.deepEqual(corrected.originals.slice(0, -1), priorOriginals);
  assert.deepEqual(corrected.originals.at(-1).record, previousRecord);
  assert.equal(Object.hasOwn(corrected.originals.at(-1).record, 'originals'), false);
  assert.deepEqual(corrected.legacyAliases, []);
  assert.equal(f.repository.getSnapshot().savedServers[1].id, b.id);
});

test('pure rename is allowed for an in-use entry and never clears legacy auth or calls the source guard', async () => {
  let guardCalls = 0;
  const original = { serverUrl: 'https://books.example', serverTitle: 'Confirmed title', token: 'fixture-token', user: { id: 7 }, offlineMode: true };
  const sources = { stateRaw: JSON.stringify({ version: 0, state: original }) };
  const f = await loaded({ sources, isEntryInUse() { guardCalls++; return true; } });
  const entry = f.repository.getSnapshot().savedServers[0];
  const sourceRaw = f.sources.stateRaw;
  const renamed = successful(await f.repository.saveServer({ rawBaseUrl: entry.url, displayName: 'Local name',
    target: { id: entry.id, expectedEntryRevision: entry.entryRevision } }), 'corrected');
  assert.equal(guardCalls, 0);
  assert.equal(renamed.id, entry.id);
  assert.equal(renamed.title, 'Confirmed title');
  assert.equal(renamed.displayName, 'Local name');
  assert.deepEqual(renamed.originals.slice(0, -1), entry.originals);
  assert.deepEqual(renamed.originals[0].record, original);
  assert.equal(renamed.originals.at(-1).source, 'rename');
  assert.equal(renamed.originals.at(-1).record.entryRevision, entry.entryRevision);
  assert.equal(Object.hasOwn(renamed.originals.at(-1).record, 'originals'), false);
  assert.equal(f.sources.stateRaw, sourceRaw);
  assert.deepEqual(JSON.parse(f.sources.stateRaw).state, original);
});

test('migration preserves every malformed record, source byte string, original position and metadata', async () => {
  const records = [
    { id: 'old-valid', url: ' HTTPS://Books.Example:443/// ', title: 'Old title', token: 'fixture-token', file: 'keep.epub' },
    { id: 'old-invalid', url: 'books.example/path', addedAt: 'old', arbitrary: { keep: ['all', 9] } },
    null,
  ];
  const stateRaw = JSON.stringify({ version: 1, state: { savedServers: records } }, null, 2);
  const urlRaw = 'https://legacy.example';
  const f = fixture({ sources: { stateRaw, urlRaw } });
  const result = await f.repository.load();
  assert.equal(result.ok, true);
  assert.equal(result.registry.savedServers.length, 4);
  for (let index = 0; index < records.length; index++) {
    const entry = result.registry.savedServers[index];
    assert.equal(entry.originals[0].index, index);
    assert.deepEqual(entry.originals[0].record, records[index]);
  }
  assert.equal(result.registry.savedServers[0].url, 'https://books.example');
  assert.equal(result.registry.savedServers[1].status, 'needs-edit');
  assert.equal(result.registry.savedServers[2].status, 'needs-edit');
  assert.deepEqual(result.registry.legacySources, { stateRaw, urlRaw });
  const backupKey = f.writes()[0][1];
  assert.deepEqual(JSON.parse(f.values.get(backupKey)), { previous: null, legacySources: { stateRaw, urlRaw } });
  const raw = f.authority();
  const ids = result.registry.savedServers.map((entry) => [entry.id, entry.entryRevision]);
  const writes = f.writes().length;
  assert.equal((await f.repository.load()).ok, true);
  assert.deepEqual(f.repository.getSnapshot().savedServers.map((entry) => [entry.id, entry.entryRevision]), ids);
  assert.equal(f.authority(), raw);
  assert.equal(f.writes().length, writes);
  assert.deepEqual(f.sources, { stateRaw, urlRaw });
});

test('unknown or malformed authoritative schema is preserved and blocks writes until load recovers', async () => {
  for (const authority of ['{"version":99,"preserve":"all"}', '{ malformed', '{"version":2,"savedServers":[]}']) {
    const f = fixture({ authority });
    const result = failed(await f.repository.load(), 'storage-failure');
    assert.equal(result.persistence, 'unchanged');
    assert.equal(result.reloadRequired, true);
    assert.equal(f.authority(), authority);
    assert.deepEqual(f.writes(), []);
    assert.equal(failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure').code, 'reload-required');
    assert.equal(f.authority(), authority);
  }
  const legacyRaw = '{"version":5,"state":{"savedServers":[]}}';
  const legacy = fixture({ sources: { stateRaw: legacyRaw } });
  assert.equal(failed(await legacy.repository.load(), 'storage-failure').code, 'unsupported-schema');
  assert.equal(legacy.authority(), undefined);
  assert.equal(legacy.sources.stateRaw, legacyRaw);
  assert.deepEqual(legacy.writes(), []);
});

test('migrated duplicate canonical entries remain visible collisions and cannot silently merge', async () => {
  const f = await loaded({ sources: { stateRaw: JSON.stringify({ version: 1, state: { savedServers: [
    { id: 'one', url: 'https://books.example/' }, { id: 'two', url: 'HTTPS://BOOKS.EXAMPLE:443' },
  ] } }) } });
  const before = f.authority();
  assert.deepEqual(f.repository.getSnapshot().savedServers.map((entry) => entry.status), ['collision', 'collision']);
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'collision');
  assert.deepEqual(new Set(result.entryIds), new Set(['one', 'two']));
  assert.equal(f.authority(), before);
  assert.deepEqual(f.writes(), []);
});

test('backup rejection and backup readback tampering leave the old authority and snapshot untouched', async () => {
  for (const fault of ['reject', 'tamper']) {
    const f = await loaded();
    const before = f.authority();
    const snapshot = f.repository.getSnapshot();
    if (fault === 'reject') f.hooks.beforeSet = (key) => { if (key !== KEY) throw new Error('fixture denied'); };
    else f.hooks.get = (key, raw) => key === KEY ? raw : 'tampered backup';
    const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure');
    assert.equal(result.persistence, 'unchanged');
    assert.equal(result.reloadRequired, true);
    if (fault === 'tamper') assert.equal(result.code, 'verification-failed');
    assert.equal(f.authority(), before);
    assert.deepEqual(f.repository.getSnapshot(), snapshot);
    assert.equal(f.writes().some(([, key]) => key === KEY), false);
    const writes = f.writes().length;
    assert.equal(failed(await f.repository.saveServer({ rawBaseUrl: 'https://other.example' }), 'storage-failure').code, 'reload-required');
    assert.equal(f.writes().length, writes);
    delete f.hooks.beforeSet;
    delete f.hooks.get;
    assert.equal((await f.repository.load()).ok, true);
    successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'created');
  }
});

test('authority write followed by unreadable verification is unknown, locked, then recovered by load with stable ID', async () => {
  const f = await loaded();
  let committed = false;
  f.hooks.afterSet = (key) => { if (key === KEY) committed = true; };
  f.hooks.get = (key, raw) => {
    if (key === KEY && committed) throw new Error('fixture readback unavailable');
    return raw;
  };
  const snapshot = f.repository.getSnapshot();
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a' }), 'storage-failure');
  assert.equal(result.persistence, 'unknown');
  assert.equal(result.reloadRequired, true);
  assert.deepEqual(f.repository.getSnapshot(), snapshot);
  const persisted = parseSavedServerRegistry(f.authority()).savedServers[0];
  const writes = f.writes().length;
  const ids = f.idCalls();
  const blocked = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a' }), 'storage-failure');
  assert.equal(blocked.code, 'reload-required');
  assert.equal(blocked.persistence, 'unknown');
  assert.equal(f.writes().length, writes);
  assert.equal(f.idCalls(), ids);
  delete f.hooks.get;
  delete f.hooks.afterSet;
  assert.equal((await f.repository.load()).ok, true);
  assert.equal(successful(await f.repository.saveServer({ rawBaseUrl: 'https://BOOKS.example:443/a/' }), 'existing').id, persisted.id);
  assert.equal(f.writes().length, writes);
  assert.equal(f.idCalls(), ids);
});

test('a failed authority write is conservatively unknown and requires authoritative reload before retry', async () => {
  const f = await loaded();
  const before = f.authority();
  f.hooks.beforeSet = (key) => { if (key === KEY) throw new Error('fixture write failure'); };
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure');
  assert.equal(result.persistence, 'unknown');
  assert.equal(f.authority(), before);
  delete f.hooks.beforeSet;
  assert.equal((await f.repository.load()).ok, true);
  successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'created');
});

test('another writer changing authority is detected before save, preserving both the disk and old snapshot', async () => {
  const f = await loaded();
  const snapshot = f.repository.getSnapshot();
  const foreign = { ...clone(snapshot), savedServers: [{
    id: 'foreign-id', entryRevision: 'foreign-revision', url: 'https://foreign.example', title: '',
    addedAt: NOW, status: 'ready', originals: [], legacyAliases: [],
  }] };
  const foreignRaw = serializeSavedServerRegistry(foreign);
  f.values.set(KEY, foreignRaw);
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure');
  assert.equal(result.code, 'configuration-changed');
  assert.equal(result.persistence, 'unchanged');
  assert.equal(f.authority(), foreignRaw);
  assert.deepEqual(f.repository.getSnapshot(), snapshot);
  assert.deepEqual(f.writes(), []);
  assert.equal((await f.repository.load()).ok, true);
  assert.equal(successful(await f.repository.saveServer({ rawBaseUrl: 'https://foreign.example' }), 'existing').id, 'foreign-id');
});

test('legacy source changed before save or during backup is detected without overwriting authority', async () => {
  for (const timing of ['before', 'during-backup']) {
    const f = await loaded();
    const before = f.authority();
    const originalSources = clone(f.sources);
    if (timing === 'before') f.sources.urlRaw = 'https://external.example';
    else f.hooks.afterSet = (key) => { if (key !== KEY) f.sources.urlRaw = 'https://external.example'; };
    const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure');
    assert.equal(result.code, 'configuration-changed');
    assert.equal(result.persistence, 'unchanged');
    assert.equal(f.authority(), before);
    assert.equal(f.writes().some(([, key]) => key === KEY), false);
    failed(await f.repository.load(), 'storage-failure');
    Object.assign(f.sources, originalSources);
    delete f.hooks.afterSet;
    assert.equal((await f.repository.load()).ok, true);
  }
});

test('a legacy change during authority commit produces unknown and does not publish stale success', async () => {
  const f = await loaded();
  const snapshot = f.repository.getSnapshot();
  f.hooks.afterSet = (key) => { if (key === KEY) f.sources.urlRaw = 'https://external.example'; };
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'storage-failure');
  assert.equal(result.code, 'configuration-changed');
  assert.equal(result.persistence, 'unknown');
  assert.deepEqual(f.repository.getSnapshot(), snapshot);
  assert.equal(parseSavedServerRegistry(f.authority()).savedServers.length, 1);
  failed(await f.repository.load(), 'storage-failure');
});

test('an authority changed during the asynchronous entry-use guard is checked again before writing', async () => {
  let afterGuard;
  const f = await loaded({ isEntryInUse: async () => { afterGuard(); return false; } });
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a' }), 'created');
  const foreign = clone(f.repository.getSnapshot());
  foreign.savedServers[0].displayName = 'Foreign edit';
  foreign.savedServers[0].entryRevision = 'foreign-revision';
  const foreignRaw = serializeSavedServerRegistry(foreign);
  afterGuard = () => f.values.set(KEY, foreignRaw);
  f.calls.length = 0;
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/b',
    target: { id: a.id, expectedEntryRevision: a.entryRevision } }), 'storage-failure');
  assert.equal(result.code, 'configuration-changed');
  assert.equal(f.authority(), foreignRaw);
  assert.deepEqual(f.writes(), []);
});

test('queued concurrent saves do not lose A or B and capture caller input before waiting', async () => {
  const f = await loaded();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let hold = true;
  f.hooks.beforeSet = async (key) => {
    if (key !== KEY && hold) { hold = false; entered(); await gate; }
  };
  const first = f.repository.saveServer({ rawBaseUrl: 'https://a.example' });
  await started;
  const command = { rawBaseUrl: 'https://b.example', displayName: 'Before mutation' };
  const second = f.repository.saveServer(command);
  command.rawBaseUrl = 'https://mutated.example';
  command.displayName = 'After mutation';
  const queuedLoad = f.repository.load();
  release();
  successful(await first, 'created');
  const b = successful(await second, 'created');
  assert.equal(b.url, 'https://b.example');
  assert.equal(b.displayName, 'Before mutation');
  assert.equal((await queuedLoad).ok, true);
  assert.deepEqual(f.repository.getSnapshot().savedServers.map((entry) => entry.url), ['https://a.example', 'https://b.example']);
});

test('snapshot, load and save results are deep copies of repository-owned records', async () => {
  const original = { serverUrl: 'https://books.example', extra: { preserve: ['value'] } };
  const f = await loaded({ sources: { stateRaw: JSON.stringify({ version: 0, state: original }) } });
  const baseline = f.repository.getSnapshot();
  const snapshot = f.repository.getSnapshot();
  snapshot.savedServers[0].originals[0].record.extra.preserve.push('mutated');
  snapshot.savedServers[0].url = 'https://foreign.example';
  snapshot.legacySources.stateRaw = null;
  const load = await f.repository.load();
  load.registry.savedServers.length = 0;
  const saved = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example' }), 'existing');
  saved.originals[0].record.extra.preserve[0] = 'changed';
  assert.deepEqual(f.repository.getSnapshot(), baseline);
});

test('the same correction request is idempotent with its original revision, including after restart', async () => {
  const f = await loaded();
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a', displayName: 'Original hint' }), 'created');
  const command = { rawBaseUrl: 'https://books.example/b/', target: { id: a.id, expectedEntryRevision: a.entryRevision } };
  const corrected = successful(await f.repository.saveServer(command), 'corrected');
  const raw = f.authority();
  const writes = f.writes().length;
  const ids = f.idCalls();
  const retry = successful(await f.repository.saveServer(command), 'existing');
  assert.deepEqual(retry, corrected);
  const restarted = new SavedServerRepository(f.storage, f.repositoryOptions);
  assert.equal((await restarted.load()).ok, true);
  assert.deepEqual(successful(await restarted.saveServer(command), 'existing'), corrected);
  assert.equal(f.authority(), raw);
  assert.equal(f.writes().length, writes);
  assert.equal(f.idCalls(), ids);
  failed(await restarted.saveServer({ ...command, rawBaseUrl: 'https://books.example/c' }), 'entry-changed');
  failed(await restarted.saveServer({ ...command, displayName: 'Unrelated new hint' }), 'entry-changed');
});

test('the same rename request is idempotent without nesting edit history or accepting later stale edits', async () => {
  const f = await loaded();
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a', displayName: 'First' }), 'created');
  const command = { rawBaseUrl: a.url, displayName: 'Second', target: { id: a.id, expectedEntryRevision: a.entryRevision } };
  const renamed = successful(await f.repository.saveServer(command), 'corrected');
  const writes = f.writes().length;
  assert.deepEqual(successful(await f.repository.saveServer(command), 'existing'), renamed);
  assert.equal(f.writes().length, writes);
  const restarted = new SavedServerRepository(f.storage, f.repositoryOptions);
  assert.equal((await restarted.load()).ok, true);
  assert.deepEqual(successful(await restarted.saveServer(command), 'existing'), renamed);
  assert.equal(f.writes().length, writes);
  const next = successful(await restarted.saveServer({ rawBaseUrl: a.url, displayName: 'Third',
    target: { id: a.id, expectedEntryRevision: renamed.entryRevision } }), 'corrected');
  assert.equal(next.originals.length, 2);
  assert.deepEqual(next.originals.map(({ source }) => source), ['rename', 'rename']);
  assert.ok(next.originals.every(({ record }) => !Object.hasOwn(record, 'originals')));
  failed(await restarted.saveServer(command), 'entry-changed');
});

test('an entry that becomes busy while backup awaits is rejected before any authority write', async () => {
  let busy = false;
  let guardCalls = 0;
  const f = await loaded({ isEntryInUse: async () => { guardCalls++; return busy; } });
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a' }), 'created');
  const before = f.authority();
  const beforeSnapshot = f.repository.getSnapshot();
  f.calls.length = 0;
  f.hooks.afterSet = (key) => { if (key !== KEY) busy = true; };
  const command = { rawBaseUrl: 'https://books.example/b', target: { id: a.id, expectedEntryRevision: a.entryRevision } };
  assert.equal(failed(await f.repository.saveServer(command), 'entry-in-use').entryId, a.id);
  assert.equal(guardCalls, 2);
  assert.equal(f.authority(), before);
  assert.deepEqual(f.repository.getSnapshot(), beforeSnapshot);
  assert.equal(f.writes().some(([, key]) => key === KEY), false);
  busy = false;
  delete f.hooks.afterSet;
  successful(await f.repository.saveServer(command), 'corrected');
});

test('the final asynchronous source guard cannot overwrite an authority changed while it awaited', async () => {
  let guardCalls = 0;
  let foreignRaw;
  const f = await loaded({ isEntryInUse: async () => {
    guardCalls++;
    if (guardCalls === 2) f.values.set(KEY, foreignRaw);
    return false;
  } });
  const a = successful(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/a' }), 'created');
  const foreign = f.repository.getSnapshot();
  foreign.savedServers[0].displayName = 'Foreign edit during final guard';
  foreign.savedServers[0].entryRevision = 'foreign-final-revision';
  foreignRaw = serializeSavedServerRegistry(foreign);
  f.calls.length = 0;
  const result = failed(await f.repository.saveServer({ rawBaseUrl: 'https://books.example/b',
    target: { id: a.id, expectedEntryRevision: a.entryRevision } }), 'storage-failure');
  assert.equal(result.code, 'configuration-changed');
  assert.equal(result.persistence, 'unchanged');
  assert.equal(f.authority(), foreignRaw);
  assert.equal(f.writes().some(([, key]) => key === KEY), false);
});
