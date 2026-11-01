import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedServerRepository, SAVED_SERVER_STORAGE_KEY } from '../src/lib/saved-server-repository.ts';
import { createSavedServerApi } from '../src/lib/saved-server-api.ts';
import { createDiscoverySaveAdapter } from '../src/lib/discovery/save-adapter.ts';
import { createNativeDiscoveryAdapter } from '../src/lib/discovery/native.ts';
import { useServerStore } from '../src/lib/store/server.ts';

const KEY = SAVED_SERVER_STORAGE_KEY;
const BASE = 'https://books.lan:8443/team/books';
const SESSION = 'browse-session';
const selected = () => ({ sessionId: SESSION, generation: 2, rowId: 'broadcast-row', baseUrl: BASE });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** Runtime wiring through the real repository/facade/native command adapter.
 * The injected IPC and disk are controlled algorithm fixtures, not proof of
 * system DNS, Tauri IPC, native persistence or a real LAN service. */
async function fixture(options = {}) {
  const disk = new Map();
  const calls = [];
  const hooks = {};
  const authority = { valid: true, code: 'admission_expired', name: 'Broadcast library' };
  const sources = { stateRaw: null, urlRaw: null, ...options.sources };
  let sequence = 0;
  const storage = {
    async getItem(key) {
      await hooks.beforeGet?.(key);
      calls.push({ kind: 'read', key });
      return disk.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push({ kind: 'storage-write', key });
      await hooks.beforeSet?.(key, value);
      disk.set(key, value);
      await hooks.afterSet?.(key, value);
    },
  };
  const repository = new SavedServerRepository(storage, {
    readLegacySources: () => ({ ...sources }),
    createId: () => `local-${++sequence}`,
    now: () => '2026-11-01T12:00:00.000Z',
    isEntryInUse: () => false,
  });
  const api = createSavedServerApi(repository);
  assert.equal((await api.loadSavedServers()).ok, true);
  const native = createNativeDiscoveryAdapter(async (command, args) => {
    calls.push({ kind: 'ipc', command, args: args && { ...args } });
    if (command === 'moke_runtime_platform') return 'linux';
    if (command === 'moke_discovery_start') return;
    if (command === 'moke_discovery_stop') { authority.valid = false; return; }
    if (command === 'moke_discovery_admit') {
      await hooks.admit?.(args);
      if (!authority.valid) throw { code: authority.code };
      assert.equal(args.sessionId, SESSION);
      assert.equal(args.rowId, 'broadcast-row');
      assert.equal(args.baseUrl, BASE);
      return hooks.admission ?? { admissionId: 'native-lease', baseUrl: BASE, name: authority.name };
    }
    if (command === 'moke_discovery_commit') {
      await hooks.beforeCommit?.(args);
      if (!authority.valid) throw { code: authority.code };
      assert.equal(args.sessionId, SESSION);
      assert.equal(args.admissionId, 'native-lease');
      if ((disk.get(KEY) ?? null) !== args.expectedRaw) throw { code: 'storage_conflict' };
      if (args.value !== args.expectedRaw) {
        disk.set(KEY, args.value);
        calls.push({ kind: 'native-write', key: KEY });
      }
      await hooks.afterCommit?.(args);
      return;
    }
    assert.fail(`Unexpected native command: ${command}`);
  });
  await native.start(SESSION);
  calls.length = 0;
  const save = createDiscoverySaveAdapter(native, api);
  return { disk, calls, hooks, authority, sources, repository, api, native, save,
    raw: () => disk.get(KEY),
    commits: () => calls.filter((call) => call.command === 'moke_discovery_commit'),
    saveSelected: (current = () => true, signal = new AbortController().signal) => save(selected(), current, signal) };
}

function succeeded(result, outcome) {
  assert.equal(result.ok, true);
  assert.equal(result.outcome, outcome);
  assert.equal(result.persisted, true);
  return result.server;
}

function rejected(result, code) {
  assert.deepEqual(result, { ok: false, outcome: 'admission-rejected', code });
}

test('discovery saves the full base once; duplicate consumes authority and keeps local id/name without HTTP or activation', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('unexpected HTTP'); });
  const beforeActive = useServerStore.getState();
  const f = await fixture();
  const saved = succeeded(await f.saveSelected(), 'created');
  assert.equal(saved.url, BASE);
  assert.equal(saved.displayName, 'Broadcast library');
  assert.match(saved.id, /^local-/);
  assert.notEqual(saved.id, selected().rowId);
  assert.equal('originals' in saved, false);
  const raw = f.raw();
  f.authority.name = 'Changed broadcast name';
  const duplicate = succeeded(await f.saveSelected(), 'existing');
  assert.deepEqual(duplicate, saved);
  assert.equal(f.raw(), raw);
  assert.equal(f.commits().length, 2);
  assert.equal(f.calls.filter((call) => call.kind === 'native-write').length, 1);
  assert.equal(f.calls.some((call) => call.kind === 'storage-write' && call.key === KEY), false);
  assert.equal(f.repository.getSnapshot().savedServers.length, 1);
  assert.equal(requests, 0);
  assert.equal(useServerStore.getState(), beforeActive);
  assert.equal(f.disk.has('moke_server_url'), false);
  assert.equal(f.disk.has('moke-server-storage'), false);
  assert.equal(f.disk.has('moke-active-session-v1'), false);
});

test('the real repository uses native commit as the last authoritative writer after its asynchronous backup', async () => {
  const f = await fixture();
  const before = f.raw();
  const order = [];
  f.hooks.afterSet = async (key) => { if (key.startsWith(`${KEY}-backup-`)) { await Promise.resolve(); order.push('backup-done'); } };
  f.hooks.beforeCommit = (args) => { order.push('native-commit'); assert.equal(args.expectedRaw, before); };
  succeeded(await f.saveSelected(), 'created');
  assert.deepEqual(order, ['backup-done', 'native-commit']);
  assert.equal(f.calls.some((call) => call.kind === 'storage-write' && call.key === KEY), false);
  assert.equal(JSON.parse(f.raw()).savedServers[0].url, BASE);
});

test('source expiry during backup is rejected by the actual last writer, with zero authority change and no manual-save contamination', async () => {
  const f = await fixture();
  const before = f.raw();
  f.hooks.afterSet = (key) => { if (key.startsWith(`${KEY}-backup-`)) f.authority.valid = false; };
  rejected(await f.saveSelected(), 'admission_expired');
  assert.equal(f.raw(), before);
  assert.equal(f.commits().length, 1);
  assert.equal(f.calls.some((call) => call.kind === 'native-write'), false);
  assert.deepEqual(f.api.getSavedServersSnapshot().savedServers, []);
  const manual = succeeded(await f.api.saveServer({ rawBaseUrl: 'https://public.example/manual' }), 'created');
  assert.equal(manual.url, 'https://public.example/manual');
  assert.equal(f.commits().length, 1);
});

test('admission cannot survive a repository queue wait; a separate queued manual save still completes', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  let firstBackup = true;
  f.hooks.beforeSet = async (key) => {
    if (key.startsWith(`${KEY}-backup-`) && firstBackup) {
      firstBackup = false;
      entered.resolve();
      await release.promise;
    }
  };
  let manual;
  const queuedSave = createDiscoverySaveAdapter(f.native, {
    loadSavedServers: f.api.loadSavedServers,
    saveAuthorizedServer(input, authorization) {
      manual = f.api.saveServer({ rawBaseUrl: 'https://public.example/queued' });
      return f.api.saveAuthorizedServer(input, authorization);
    },
  });
  const result = queuedSave(selected(), () => true, new AbortController().signal);
  await entered.promise;
  f.authority.valid = false;
  release.resolve();
  rejected(await result, 'admission_expired');
  succeeded(await manual, 'created');
  assert.deepEqual(f.repository.getSnapshot().savedServers.map((entry) => entry.url), ['https://public.example/queued']);
  assert.equal(f.calls.some((call) => call.kind === 'native-write'), false);
});

test('selection changes and aborts during backup stop before any native commit', async () => {
  for (const abort of [false, true]) {
    const f = await fixture();
    const before = f.raw();
    let current = true;
    const controller = new AbortController();
    f.hooks.afterSet = (key) => {
      if (key.startsWith(`${KEY}-backup-`)) {
        if (abort) controller.abort();
        else current = false;
      }
    };
    rejected(await f.saveSelected(() => current, controller.signal), 'cancelled');
    assert.equal(f.raw(), before);
    assert.equal(f.commits().length, 0);
  }
});

test('late admission cannot revive a changed selection or an aborted save', async () => {
  for (const abort of [false, true]) {
    const f = await fixture();
    const before = f.raw();
    const entered = deferred();
    const release = deferred();
    let current = true;
    const controller = new AbortController();
    f.hooks.admit = async () => { entered.resolve(); await release.promise; };
    const saving = f.saveSelected(() => current, controller.signal);
    await entered.promise;
    if (abort) controller.abort();
    else current = false;
    release.resolve();
    rejected(await saving, 'cancelled');
    assert.equal(f.raw(), before);
    assert.equal(f.commits().length, 0);
  }
});

test('selection is captured before asynchronous load/admit rather than reread from a caller-owned object', async () => {
  const f = await fixture();
  const selection = selected();
  const saving = f.save(selection, () => true, new AbortController().signal);
  selection.baseUrl = 'https://attacker.example';
  selection.sessionId = 'new-session';
  selection.rowId = 'new-row';
  assert.equal(succeeded(await saving, 'created').url, BASE);
  assert.equal(f.commits()[0].args.sessionId, SESSION);
});

test('every documented pre-write native rejection preserves authority and remains safely distinct from unknown IO', async () => {
  for (const code of ['candidate_unavailable', 'admission_expired', 'storage_conflict', 'invalid_payload',
    'invalid_admission', 'stopped', 'unsupported', 'forbidden', 'invalid_session', 'admission_busy',
    'backend_failure', 'network_changed']) {
    const f = await fixture();
    const before = f.raw();
    f.hooks.beforeCommit = () => { throw { code }; };
    rejected(await f.saveSelected(), code);
    assert.equal(f.raw(), before, code);
    assert.equal(f.api.getSavedServersSnapshot().savedServers.length, 0, code);
    succeeded(await f.api.saveServer({ rawBaseUrl: `https://public.example/${code}` }), 'created');
  }
});

test('completed native commit with a lost reply stays unknown until explicit reload, with no automatic retry or duplicate', async () => {
  const f = await fixture();
  f.hooks.afterCommit = () => { throw new Error('IPC reply disconnected after rename'); };
  const result = await f.saveSelected();
  assert.equal(result.outcome, 'storage-failure');
  assert.equal(result.persistence, 'unknown');
  assert.equal(result.reloadRequired, true);
  assert.equal(f.commits().length, 1);
  assert.equal(f.api.getSavedServersSnapshot().savedServers.length, 0);
  const persisted = JSON.parse(f.raw()).savedServers;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].url, BASE);
  const blocked = await f.api.saveServer({ rawBaseUrl: BASE });
  assert.equal(blocked.code, 'reload-required');
  assert.equal(blocked.persistence, 'unknown');
  assert.equal(f.commits().length, 1);
  const reloaded = await f.api.loadSavedServers();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.savedServers[0].id, persisted[0].id);
  delete f.hooks.afterCommit;
  const duplicate = succeeded(await f.saveSelected(), 'existing');
  assert.equal(duplicate.id, persisted[0].id);
  assert.equal(f.calls.filter((call) => call.kind === 'native-write').length, 1);
});

test('an unclassified pre-write transport failure is also unknown and reload reconciles the unchanged authority', async () => {
  const f = await fixture();
  const before = f.raw();
  f.hooks.beforeCommit = () => { throw { code: 'ipc_lost' }; };
  const result = await f.saveSelected();
  assert.equal(result.outcome, 'storage-failure');
  assert.equal(result.persistence, 'unknown');
  assert.equal(result.reloadRequired, true);
  assert.equal(f.raw(), before);
  assert.equal(f.commits().length, 1);
  const loaded = await f.api.loadSavedServers();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.savedServers, []);
});

test('a changed admitted base cannot write an arbitrary caller URL and an unsupported adapter cannot load or save', async () => {
  const f = await fixture();
  const before = f.raw();
  f.hooks.admission = { admissionId: 'native-lease', baseUrl: 'https://attacker.example', name: 'untrusted' };
  rejected(await f.saveSelected(), 'invalid_admission');
  assert.equal(f.raw(), before);
  assert.equal(f.commits().length, 0);
  const unsupported = createDiscoverySaveAdapter({ start: async () => {}, snapshot: async () => ({}), stop: async () => {} }, {
    loadSavedServers: () => assert.fail('unsupported adapter must not load'),
    saveAuthorizedServer: () => assert.fail('unsupported adapter must not save'),
  });
  rejected(await unsupported(selected(), () => true, new AbortController().signal), 'unsupported');
});

test('expired authority rejects even duplicate saved entries; later TTL/stop does not revoke the independently saved row', async () => {
  const f = await fixture();
  const saved = succeeded(await f.saveSelected(), 'created');
  const before = f.raw();
  f.hooks.beforeCommit = () => { throw { code: 'admission_expired' }; };
  rejected(await f.saveSelected(), 'admission_expired');
  await f.native.stop(SESSION);
  assert.equal(f.raw(), before);
  const loaded = await f.api.loadSavedServers();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.savedServers[0].id, saved.id);
  const calls = f.calls.length;
  assert.equal(succeeded(await f.api.saveServer({ rawBaseUrl: BASE }), 'existing').id, saved.id);
  assert.equal(f.calls.slice(calls).some((call) => call.kind === 'ipc'), false);
});

test('ordinary manual public IDNA/long saves and malformed migration originals have no discovery-policy dependency', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('manual save must not probe HTTP'));
  const stateRaw = JSON.stringify({ version: 1, state: { savedServers: [
    { id: 'malformed-original', url: 'books.example/path', privateMetadata: 'keep-original' },
  ] } });
  const f = await fixture({ sources: { stateRaw } });
  const original = f.repository.getSnapshot().savedServers[0];
  assert.equal(original.status, 'needs-edit');
  f.authority.valid = false;
  const url = `https://书库.example/${'a'.repeat(260)}`;
  const saved = succeeded(await f.api.saveServer({ rawBaseUrl: url, displayName: 'Manual public' }), 'created');
  assert.equal(saved.url, `https://xn--1jq370b.example/${'a'.repeat(260)}`);
  assert.equal(f.sources.stateRaw, stateRaw);
  assert.deepEqual(f.repository.getSnapshot().savedServers[0], original);
  assert.equal(f.calls.some((call) => call.kind === 'ipc'), false);
});
