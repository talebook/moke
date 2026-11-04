import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { nativeConnection } from '../src/lib/native-connection.ts';
import '../src/lib/store/server.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (text) => [...new TextEncoder().encode(text), 0];
let moduleId = 0;

async function downloadFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const reads = [];
  const counts = { dispatch: 0, settle: 0, uncertain: 0 };
  const lease = { documentToken: 'document', leaseToken: 'lease', epoch: 1, baseUrl: 'https://books.test' };
  t.mock.method(nativeConnection, 'activeLease', () => lease);
  t.mock.method(nativeConnection, 'registerCancellation', () => () => {});
  t.mock.method(nativeConnection, 'dispatch', async () => { counts.dispatch++; return { lease, requestId: 'original-ticket', epoch: 1 }; });
  t.mock.method(nativeConnection, 'assertDispatchCurrent', () => {});
  t.mock.method(nativeConnection, 'settle', async (ticket) => {
    assert.equal(ticket.requestId, 'original-ticket');
    counts.settle++;
  });
  t.mock.method(nativeConnection, 'markUncertain', () => { counts.uncertain++; });
  const previousWindow = globalThis.window;
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 7;
    if (command === 'plugin:http|fetch_send') return {
      status: 200, statusText: 'OK', url: 'https://books.test/api/book/1.txt',
      headers: [['content-length', '20']], rid: 8,
    };
    if (command === 'plugin:http|fetch_read_body') {
      const read = Promise.withResolvers();
      reads.push(read);
      return read.promise;
    }
    if (command === 'plugin:http|fetch_cancel_body') {
      reads.at(-1)?.resolve([1]);
      return;
    }
    throw new Error(`Unexpected IPC ${command}`);
  } } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  });
  const api = await import(`../src/lib/api.ts?download-deadline=${moduleId++}`);
  return {
    ...api, calls, reads, counts,
    async advance(ms) { t.mock.timers.tick(ms); await tick(); },
  };
}

test('streamBookDownload keeps progressing beyond 30 seconds through the real request/native HTTP chain', async (t) => {
  const f = await downloadFixture(t);
  const chunks = [];
  const pending = f.streamBookDownload(1, 'txt', {
    serverUrl: 'https://books.test', write: async (chunk) => { chunks.push(chunk); },
  });
  const result = pending.then((value) => ({ value }), (error) => ({ error }));
  await tick();
  for (let index = 0; index < 4; index++) {
    await f.advance(10_000);
    if (!f.reads[index]) break;
    f.reads[index].resolve(frame('hello'));
    await tick();
  }
  f.reads[4]?.resolve([1]);
  assert.deepEqual((await result).value, {
    mimeType: 'application/octet-stream', size: 20, sourceSignature: undefined, resumed: false,
  });
  assert.equal(new TextDecoder().decode(Buffer.concat(chunks)), 'hellohellohellohello');
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
  assert.equal(f.calls.filter(({ command }) => command === 'plugin:http|fetch').length, 1);
  assert.equal(f.calls.filter(({ command }) => command.startsWith('plugin:http|fetch_cancel')).length, 0);
});
