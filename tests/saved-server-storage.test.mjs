import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrowserSavedServerStorage,
  createNativeSavedServerStorage,
  MAX_SAVED_SERVER_STORAGE_BYTES,
  readLegacyNativeSources,
} from '../src/lib/saved-server-storage.ts';

const KEY = 'moke-saved-servers-v2';
const PATH = `server-registry/${KEY}.json`;
const TEMP = `${PATH}.test-id.tmp`;
const LEGACY = 'books/.servers/moke-server-storage.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nativeFixture(initial = {}) {
  const files = new Map(Object.entries(initial).map(([path, value]) => [path,
    typeof value === 'string' ? encoder.encode(value) : value]));
  const calls = [];
  const state = { readLimit: 3, writeLimit: 3 };
  const fs = {
    BaseDirectory: { AppConfig: 13, AppData: 14 },
    async exists(path, options) {
      calls.push(['exists', path, options]);
      if (state.existsError) throw state.existsError;
      return files.has(path);
    },
    async mkdir(path, options) { calls.push(['mkdir', path, options]); },
    async open(path, options) {
      calls.push(['open', path, options]);
      if (state.openError) throw state.openError;
      if (options.createNew) {
        if (files.has(path)) throw new Error('already exists');
        files.set(path, new Uint8Array());
      }
      let position = 0;
      let statCalls = 0;
      return {
        async stat() {
          statCalls++;
          return { size: state.statSize ?? ((state.changeSize && statCalls > 1)
            ? files.get(path).length + 1 : files.get(path).length) };
        },
        async read(buffer) {
          calls.push(['read', path, buffer.length]);
          if (state.readError) throw state.readError;
          if (state.readCount !== undefined) return state.readCount;
          const available = files.get(path).subarray(position, position + Math.min(buffer.length, state.readLimit));
          buffer.set(available);
          position += available.length;
          return available.length || null;
        },
        async write(buffer) {
          calls.push(['write', path, buffer.length]);
          if (state.writeError) throw state.writeError;
          if (state.writeCount !== undefined) return state.writeCount;
          const count = Math.min(buffer.length, state.writeLimit);
          const previous = files.get(path);
          const next = new Uint8Array(previous.length + count);
          next.set(previous);
          next.set(buffer.subarray(0, count), previous.length);
          files.set(path, next);
          return count;
        },
        async close() {
          calls.push(['close', path]);
          if (state.closeError) throw state.closeError;
        },
      };
    },
    async rename(oldPath, newPath, options) {
      calls.push(['rename', oldPath, newPath, options]);
      if (state.renameError) throw state.renameError;
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
    },
    async remove(path, options) {
      calls.push(['remove', path, options]);
      if (state.removeError) throw state.removeError;
      files.delete(path);
    },
  };
  const options = { loadFs: async () => fs, createTemporaryId: () => 'test-id' };
  return { files, calls, state, options, storage: createNativeSavedServerStorage(options) };
}

test('browser storage reads and writes its authoritative key, including backup suffixes', async () => {
  const values = new Map();
  const storage = createBrowserSavedServerStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
  assert.equal(await storage.getItem(KEY), null);
  await storage.setItem(KEY, '原配置');
  await storage.setItem(`${KEY}-backup-123-ABC`, '备份');
  assert.equal(await storage.getItem(KEY), '原配置');
  assert.equal(await storage.getItem(`${KEY}-backup-123-ABC`), '备份');
});

test('browser adapter awaits injected asynchronous storage and propagates failures', async () => {
  const unavailable = new Error('unavailable');
  const rejected = new Error('write rejected');
  const storage = createBrowserSavedServerStorage({
    async getItem() { throw unavailable; },
    async setItem() { throw rejected; },
  });
  await assert.rejects(storage.getItem(KEY), (error) => error === unavailable);
  await assert.rejects(storage.setItem(KEY, 'value'), (error) => error === rejected);
});

test('browser default does not treat a denied localStorage getter as an empty list', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const denied = new Error('denied');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw denied; },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  const storage = createBrowserSavedServerStorage();
  await assert.rejects(storage.getItem(KEY), (error) => error === denied);
  await assert.rejects(storage.setItem(KEY, '{}'), (error) => error === denied);
});

test('keys cannot escape either storage namespace or native paths', async () => {
  const fixture = nativeFixture();
  let browserCalls = 0;
  const browser = createBrowserSavedServerStorage({
    getItem() { browserCalls++; return null; },
    setItem() { browserCalls++; },
  });
  for (const key of ['../secret', `${KEY}/../secret`, `${KEY}\\other`, `${KEY}.backup`,
    `${KEY}_backup`, `${KEY}-`, 'moke-server-storage', `${KEY}-a\n`, `${KEY}-${'a'.repeat(200)}`]) {
    for (const storage of [browser, fixture.storage]) {
      await assert.rejects(storage.getItem(key), /invalid_key/);
      await assert.rejects(storage.setItem(key, 'value'), /invalid_key/);
    }
  }
  assert.equal(browserCalls, 0);
  assert.deepEqual(fixture.calls, []);
});

test('native reads the full UTF-8 file through short reads in AppConfig', async () => {
  const value = '{"原件":"书库🙂"}';
  const { storage, calls } = nativeFixture({ [PATH]: value });
  assert.equal(await storage.getItem(KEY), value);
  assert.deepEqual(calls[0], ['exists', PATH, { baseDir: 13 }]);
  assert.deepEqual(calls[1], ['open', PATH, { baseDir: 13, read: true }]);
  assert.ok(calls.filter(([operation]) => operation === 'read').length > 1);
  assert.deepEqual(calls.at(-1), ['close', PATH]);
});

test('native writes every byte, closes before atomic rename, and replaces only its target', async () => {
  const { storage, files, calls } = nativeFixture({ [PATH]: 'old', 'unrelated.json': 'keep' });
  const value = '{"原件":"书库🙂"}';
  await storage.setItem(KEY, value);
  assert.equal(decoder.decode(files.get(PATH)), value);
  assert.equal(decoder.decode(files.get('unrelated.json')), 'keep');
  assert.equal(files.has(TEMP), false);
  assert.deepEqual(calls[0], ['mkdir', 'server-registry', { baseDir: 13, recursive: true }]);
  assert.deepEqual(calls[1], ['open', TEMP, { baseDir: 13, write: true, createNew: true }]);
  assert.ok(calls.filter(([operation]) => operation === 'write').length > 1);
  assert.deepEqual(calls.at(-2), ['close', TEMP]);
  assert.deepEqual(calls.at(-1), ['rename', TEMP, PATH, { oldPathBaseDir: 13, newPathBaseDir: 13 }]);
});

test('missing native state does not fall back to an old H file', async () => {
  const { storage, options, calls } = nativeFixture({ [LEGACY]: 'old native source' });
  assert.equal(await storage.getItem(KEY), null);
  assert.deepEqual(calls, [['exists', PATH, { baseDir: 13 }]]);
  assert.deepEqual(await readLegacyNativeSources(options), [{
    source: 'native', key: 'moke-server-storage', path: LEGACY, raw: 'old native source',
  }]);
  assert.ok(calls.some(([operation, path, options]) => operation === 'open'
    && path === LEGACY && options.baseDir === 14 && options.read === true));
  assert.equal(calls.some(([operation]) => ['mkdir', 'write', 'rename', 'remove'].includes(operation)), false);
});

test('native legacy source absence is explicit and access errors are not swallowed', async () => {
  const fixture = nativeFixture();
  assert.deepEqual(await readLegacyNativeSources(fixture.options), []);
  const denied = new Error('native denied');
  fixture.state.existsError = denied;
  await assert.rejects(readLegacyNativeSources(fixture.options), (error) => error === denied);
});

test('zero-byte reads and invalid UTF-8 fail while closing the file', async () => {
  const incomplete = nativeFixture({ [PATH]: 'bytes' });
  incomplete.state.readCount = 0;
  await assert.rejects(incomplete.storage.getItem(KEY), /incomplete_read/);
  assert.deepEqual(incomplete.calls.at(-1), ['close', PATH]);
  const malformed = nativeFixture({ [PATH]: new Uint8Array([0xff]) });
  await assert.rejects(malformed.storage.getItem(KEY), TypeError);
  assert.deepEqual(malformed.calls.at(-1), ['close', PATH]);
});

test('native checks the file size before allocating and detects a changing read', async () => {
  const oversized = nativeFixture({ [PATH]: 'value' });
  oversized.state.statSize = MAX_SAVED_SERVER_STORAGE_BYTES + 1;
  await assert.rejects(oversized.storage.getItem(KEY), /too_large/);
  assert.equal(oversized.calls.some(([operation]) => operation === 'read'), false);
  assert.deepEqual(oversized.calls.at(-1), ['close', PATH]);
  const changed = nativeFixture({ [PATH]: 'value' });
  changed.state.changeSize = true;
  await assert.rejects(changed.storage.getItem(KEY), /changed_during_read/);
});

test('oversized UTF-8 values are refused by both adapters before any write', async () => {
  const value = '库'.repeat(Math.floor(MAX_SAVED_SERVER_STORAGE_BYTES / 3) + 1);
  let writes = 0;
  const browser = createBrowserSavedServerStorage({ getItem: () => value, setItem() { writes++; } });
  const fixture = nativeFixture();
  await assert.rejects(browser.getItem(KEY), /too_large/);
  for (const storage of [browser, fixture.storage]) await assert.rejects(storage.setItem(KEY, value), /too_large/);
  assert.equal(writes, 0);
  assert.deepEqual(fixture.calls, []);
});

test('failed exclusive open never removes an existing temporary file', async () => {
  const { storage, files, calls } = nativeFixture({ [PATH]: 'old', [TEMP]: 'other writer' });
  await assert.rejects(storage.setItem(KEY, 'new'), /already exists/);
  assert.equal(decoder.decode(files.get(PATH)), 'old');
  assert.equal(decoder.decode(files.get(TEMP)), 'other writer');
  assert.equal(calls.some(([operation]) => operation === 'remove'), false);
});

for (const failure of ['writeError', 'closeError', 'renameError']) {
  test(`native ${failure} preserves the target and cleans only its own temporary file`, async () => {
    const fixture = nativeFixture({ [PATH]: 'old', 'server-registry/other.tmp': 'keep' });
    const original = new Error(failure);
    fixture.state[failure] = original;
    await assert.rejects(fixture.storage.setItem(KEY, 'new'), (error) => error === original);
    assert.equal(decoder.decode(fixture.files.get(PATH)), 'old');
    assert.equal(decoder.decode(fixture.files.get('server-registry/other.tmp')), 'keep');
    assert.equal(fixture.files.has(TEMP), false);
    assert.deepEqual(fixture.calls.filter(([operation]) => operation === 'remove'), [
      ['remove', TEMP, { baseDir: 13 }],
    ]);
    if (failure !== 'renameError') assert.equal(fixture.calls.some(([operation]) => operation === 'rename'), false);
  });
}

test('cleanup and close failures do not mask the original read or write error', async () => {
  const reading = nativeFixture({ [PATH]: 'old' });
  const originalRead = new Error('read failure');
  reading.state.readError = originalRead;
  reading.state.closeError = new Error('close failure');
  await assert.rejects(reading.storage.getItem(KEY), (error) => error === originalRead);
  const writing = nativeFixture({ [PATH]: 'old' });
  const originalWrite = new Error('write failure');
  writing.state.writeError = originalWrite;
  writing.state.closeError = new Error('close failure');
  writing.state.removeError = new Error('cleanup failure');
  await assert.rejects(writing.storage.setItem(KEY, 'new'), (error) => error === originalWrite);
  assert.equal(decoder.decode(writing.files.get(PATH)), 'old');
});

test('zero-byte writes fail and an invalid temporary suffix never reaches native IO', async () => {
  const fixture = nativeFixture({ [PATH]: 'old' });
  fixture.state.writeCount = 0;
  await assert.rejects(fixture.storage.setItem(KEY, 'new'), /incomplete_write/);
  assert.equal(decoder.decode(fixture.files.get(PATH)), 'old');
  const invalid = nativeFixture();
  const storage = createNativeSavedServerStorage({ ...invalid.options, createTemporaryId: () => '../other' });
  await assert.rejects(storage.setItem(KEY, 'new'), /invalid_temporary_id/);
  assert.deepEqual(invalid.calls, []);
});
