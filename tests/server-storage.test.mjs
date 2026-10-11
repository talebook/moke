import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mockCrypto } from './helpers/crypto-context.mjs';

// Exercise the native adapter and repository with synthetic IPC files. This
// verifies fallback/recovery semantics, not a real device's filesystem ACL.
const files = globalThis.__serverStorageFiles = new Map();
const events = globalThis.__serverStorageEvents = [];
registerHooks({ resolve(specifier, context, next) {
  if (specifier !== '@tauri-apps/plugin-fs') return next(specifier, context);
  return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export const BaseDirectory = { AppData: 14 };
    export async function exists(path) { return globalThis.__serverStorageFiles.has(path); }
    export async function mkdir() {
      if (globalThis.__serverStorageRejectWrite) throw new Error('disk full');
    }
    export async function rename(from, to) {
      globalThis.__serverStorageEvents.push('rename:' + from);
      if (globalThis.__serverStorageFailures?.rename) throw globalThis.__serverStorageFailures.rename;
      const files = globalThis.__serverStorageFiles;
      files.set(to, files.get(from)); files.delete(from);
    }
    export async function remove(path) {
      globalThis.__serverStorageEvents.push('remove:' + path);
      if (globalThis.__serverStorageFailures?.remove) throw globalThis.__serverStorageFailures.remove;
      globalThis.__serverStorageFiles.delete(path);
    }
    export async function open(path, options) {
      const files = globalThis.__serverStorageFiles;
      globalThis.__serverStorageEvents.push('open:' + path);
      if (options.createNew) {
        if (files.has(path)) throw new Error('already exists');
        files.set(path, new Uint8Array());
      }
      let position = 0;
      return {
        stat: async () => ({ size: files.get(path).length }),
        read: async (target) => {
          const remaining = files.get(path).subarray(position, position + target.length);
          target.set(remaining); position += remaining.length; return remaining.length;
        },
        write: async (bytes) => {
          const failure = globalThis.__serverStorageFailures;
          globalThis.__serverStorageEvents.push('write:' + path);
          if (failure?.write) throw failure.write;
          if (failure?.zeroWrite) return 0;
          const count = Math.min(bytes.length, failure?.writeLimit ?? bytes.length);
          const next = new Uint8Array(position + count);
          next.set(files.get(path)); next.set(bytes.subarray(0, count), position);
          files.set(path, next); position += count; return count;
        },
        close: async () => {
          globalThis.__serverStorageEvents.push('close:' + path);
          if (globalThis.__serverStorageFailures?.close) throw globalThis.__serverStorageFailures.close;
        },
      };
    }
  `) };
} });
const { createNativeServerStorage, createServerRepository } = await import('../src/lib/server-storage.ts');
const { ServerRegistryRepository, SERVER_STORAGE_KEY, emptyRegistry, serializeServerRegistry } = await import('../src/lib/server-registry.ts');

async function inNative(run) {
  const previousWindow = globalThis.window;
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  files.clear();
  events.length = 0;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  try { await run(); } finally {
    files.clear(); events.length = 0;
    delete globalThis.__serverStorageRejectWrite;
    delete globalThis.__serverStorageFailures;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  }
}

test('fresh native install loads and writes when ArkWeb rejects its localStorage getter or reads', () => inNative(async () => {
  for (const denied of [
    { get localStorage() { throw new DOMException('denied', 'SecurityError'); } },
    { localStorage: { getItem() { throw new DOMException('denied', 'SecurityError'); } } },
  ]) {
    files.clear(); globalThis.window = denied;
    const result = await createServerRepository().load();
    assert.deepEqual(result, { ok: true, value: emptyRegistry() });
    assert.equal(new TextDecoder().decode(files.get(`books/.servers/${SERVER_STORAGE_KEY}.json`)), serializeServerRegistry(emptyRegistry()));
  }
}));

test('native recovery scope ends on success and failure and never leaks to another adapter', () => inNative(async () => {
  const raw = serializeServerRegistry({ savedServers: [{ id:'a', url:'http://a.test', title:'A', addedAt:'' }] });
  globalThis.window = { localStorage: { getItem: (key) => key === SERVER_STORAGE_KEY ? raw : null } };
  for (const rejected of [true, false]) {
    files.clear(); globalThis.__serverStorageRejectWrite = rejected;
    const adapter = createNativeServerStorage();
    const result = await new ServerRegistryRepository(adapter, { getItem: () => null, setItem() {} }).recover();
    assert.equal(result.ok, !rejected);
    if (!rejected) files.delete(`books/.servers/${SERVER_STORAGE_KEY}.json`);
    assert.equal(await adapter.getItem(SERVER_STORAGE_KEY), raw);
    const finish = adapter.prepareRecovery();
    assert.equal(await adapter.getItem(SERVER_STORAGE_KEY), null);
    assert.equal(await createNativeServerStorage().getItem(SERVER_STORAGE_KEY), raw);
    finish();
    assert.equal(await adapter.getItem(SERVER_STORAGE_KEY), raw);
  }
}));

test('native temporary files and recovery backups work without randomUUID or Web Crypto', (context) => inNative(async () => {
  mockCrypto(context, undefined);
  globalThis.window = { localStorage: { getItem: () => null } };
  const repository = createServerRepository();
  assert.equal((await repository.load()).ok, true);
  const savedServers = [{ id: 'a', url: 'http://a.test', title: 'A', addedAt: '' }];
  assert.equal((await repository.save({ savedServers })).ok, true);
  assert.deepEqual((await createServerRepository().load()).value.savedServers, savedServers);
  assert.equal((await repository.recover()).ok, true);
  assert.equal([...files.keys()].some(path => path.endsWith('.tmp')), false);
  assert.equal([...files.keys()].filter(path => path.includes('-backup-')).length, 1);
}));

test('native failed writes close and remove only their temporary file, preserving the existing target', () => inNative(async () => {
  const target = `books/.servers/${SERVER_STORAGE_KEY}.json`;
  const oldBytes = new TextEncoder().encode('original');
  for (const failures of [
    { zeroWrite: true },
    { write: new Error('write failed') },
    { close: new Error('close failed') },
    { rename: new Error('rename failed') },
  ]) {
    files.clear(); events.length = 0;
    files.set(target, oldBytes);
    globalThis.__serverStorageFailures = failures;
    await assert.rejects(createNativeServerStorage().setItem(SERVER_STORAGE_KEY, 'replacement'),
      { message: failures.write?.message ?? failures.close?.message ?? failures.rename?.message ?? '服务器配置文件写入不完整' });
    assert.deepEqual(files.get(target), oldBytes);
    assert.deepEqual([...files.keys()], [target]);
    const removed = events.find(event => event.startsWith('remove:'));
    assert.match(removed, /^remove:books\/\.servers\/moke-server-storage\.json\..+\.tmp$/);
    assert.equal(events.some(event => event === `remove:${target}`), false);
    assert.ok(events.indexOf(removed) > events.findIndex(event => event.startsWith('close:')));
  }
}));

test('native cleanup failures do not replace the original write or rename error', () => inNative(async () => {
  const target = `books/.servers/${SERVER_STORAGE_KEY}.json`;
  for (const failedOperation of ['write', 'rename']) {
    files.clear(); events.length = 0;
    const original = new Error(`${failedOperation} failed`);
    globalThis.__serverStorageFailures = {
      [failedOperation]: original, remove: new Error('remove failed'),
      ...(failedOperation === 'write' ? { close: new Error('close failed') } : {}),
    };
    await assert.rejects(createNativeServerStorage().setItem(SERVER_STORAGE_KEY, 'replacement'), error => error === original);
    assert.equal(files.has(target), false);
    assert.equal([...files.keys()].length, 1);
    assert.equal(events.filter(event => event.startsWith('remove:')).length, 1);
    assert.equal(events.filter(event => event.startsWith('close:')).length, 1);
  }
}));

test('native successful short writes close once and rename without deleting the target', () => inNative(async () => {
  globalThis.__serverStorageFailures = { writeLimit: 2 };
  const value = 'server 字节';
  await createNativeServerStorage().setItem(SERVER_STORAGE_KEY, value);
  assert.equal(new TextDecoder().decode(files.get(`books/.servers/${SERVER_STORAGE_KEY}.json`)), value);
  assert.equal(events.filter(event => event.startsWith('write:')).length > 1, true);
  assert.equal(events.filter(event => event.startsWith('close:')).length, 1);
  assert.equal(events.filter(event => event.startsWith('remove:')).length, 0);
  assert.equal([...files.keys()].some(path => path.endsWith('.tmp')), false);
}));

test('native createNew collisions never remove another writer\'s temporary file', context => inNative(async () => {
  const id = 'same-id';
  mockCrypto(context, { randomUUID: () => id });
  const temporary = `books/.servers/${SERVER_STORAGE_KEY}.json.${id}.tmp`;
  const original = new TextEncoder().encode('other writer');
  files.set(temporary, original);
  await assert.rejects(createNativeServerStorage().setItem(SERVER_STORAGE_KEY, 'replacement'), /already exists/);
  assert.deepEqual(files.get(temporary), original);
  assert.equal(events.some(event => event.startsWith('remove:') || event.startsWith('close:')), false);
}));
