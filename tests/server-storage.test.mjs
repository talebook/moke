import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mockCrypto } from './helpers/crypto-context.mjs';

// Exercise the native adapter and repository with synthetic IPC files. This
// verifies fallback/recovery semantics, not a real device's filesystem ACL.
const files = globalThis.__serverStorageFiles = new Map();
registerHooks({ resolve(specifier, context, next) {
  if (specifier !== '@tauri-apps/plugin-fs') return next(specifier, context);
  return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export const BaseDirectory = { AppData: 14 };
    export async function exists(path) { return globalThis.__serverStorageFiles.has(path); }
    export async function mkdir() {
      if (globalThis.__serverStorageRejectWrite) throw new Error('disk full');
    }
    export async function rename(from, to) {
      const files = globalThis.__serverStorageFiles;
      files.set(to, files.get(from)); files.delete(from);
    }
    export async function open(path, options) {
      const files = globalThis.__serverStorageFiles;
      if (options.createNew) files.set(path, new Uint8Array());
      let position = 0;
      return {
        stat: async () => ({ size: files.get(path).length }),
        read: async (target) => {
          const remaining = files.get(path).subarray(position, position + target.length);
          target.set(remaining); position += remaining.length; return remaining.length;
        },
        write: async (bytes) => { files.set(path, bytes.slice()); return bytes.length; },
        close: async () => {},
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
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  try { await run(); } finally {
    files.clear(); delete globalThis.__serverStorageRejectWrite;
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
