import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedServerRepository, SAVED_SERVER_STORAGE_KEY } from '../src/lib/saved-server-repository.ts';
import { createSavedServerApi } from '../src/lib/saved-server-api.ts';

function setup(stateRaw = null) {
  const disk = new Map();
  let number = 0;
  const repo = new SavedServerRepository({
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => { disk.set(key, value); },
  }, { readLegacySources: () => ({ stateRaw, urlRaw: null }),
    createId: () => `id-${++number}`, now: () => '2026-11-01', isEntryInUse: () => false });
  return { disk, repo, api: createSavedServerApi(repo) };
}

test('facade persists A/B without network, connection changes, or discovery lifetime requirements', async () => {
  const priorFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('unexpected network'); };
  try {
    const { api, disk } = setup();
    assert.equal(api.getSavedServersSnapshot().loaded, false);
    const a = await api.saveServer({ rawBaseUrl: 'https://books.example/a' });
    const b = await api.saveServer({ rawBaseUrl: 'https://books.example/b' });
    assert.equal(a.outcome, 'created');
    assert.equal(b.outcome, 'created');
    assert.notEqual(a.server.id, b.server.id);
    assert.equal(api.getSavedServersSnapshot().savedServers.length, 2);
    assert.equal(api.getSavedServersSnapshot().busy, false);
    const again = createSavedServerApi(new SavedServerRepository({
      getItem: (key) => disk.get(key) ?? null, setItem: () => assert.fail('reload must not write'),
    }, { readLegacySources: () => ({ stateRaw: null, urlRaw: null }) }));
    const loaded = await again.loadSavedServers();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.savedServers.map((s) => s.id), [a.server.id, b.server.id]);
    assert.equal(requests, 0);
    assert.equal(disk.has('moke-server-storage'), false);
    assert.equal(disk.has('moke_server_url'), false);
  } finally { globalThis.fetch = priorFetch; }
});

test('public facade does not disclose private legacy originals or return mutable list state', async () => {
  const raw = JSON.stringify({ version: 0, state: { serverUrl: 'https://books.example', token: 'fixture-private' } });
  const { api, disk } = setup(raw);
  const loaded = await api.loadSavedServers();
  assert.equal(loaded.ok, true);
  assert.equal(JSON.stringify(loaded).includes('fixture-private'), false);
  const added = await api.saveServer({ rawBaseUrl: 'https://books.example' });
  assert.equal(added.outcome, 'existing');
  assert.equal('originals' in added.server, false);
  added.server.url = 'https://wrong.example';
  loaded.savedServers.length = 0;
  assert.equal(api.getSavedServersSnapshot().savedServers[0].url, 'https://books.example');
  assert.equal(disk.get(SAVED_SERVER_STORAGE_KEY).includes('fixture-private'), true);
});

test('needs-edit canonical match does not create a duplicate; explicit same-address repair preserves identity history', async () => {
  const raw = JSON.stringify({ version: 1, state: { savedServers: [
    { id: 'original', url: 'https://books.example', title: 'Verified old title', displayName: 'bad\nname', addedAt: 'old' },
  ] } });
  const { api, repo } = setup(raw);
  const loaded = await api.loadSavedServers();
  const original = loaded.savedServers[0];
  assert.equal(original.status, 'needs-edit');
  const duplicate = await api.saveServer({ rawBaseUrl: 'https://books.example' });
  assert.equal(duplicate.outcome, 'needs-edit');
  assert.equal(repo.getSnapshot().savedServers.length, 1);
  const corrected = await api.saveServer({ rawBaseUrl: original.url, displayName: '更正名称',
    target: { id: original.id, expectedEntryRevision: original.entryRevision } });
  assert.equal(corrected.outcome, 'corrected');
  assert.equal(corrected.server.status, 'ready');
  assert.equal(corrected.server.id, original.id);
  assert.equal(corrected.server.title, 'Verified old title');
  assert.equal(repo.getSnapshot().savedServers[0].originals[0].record.displayName, 'bad\nname');
});
