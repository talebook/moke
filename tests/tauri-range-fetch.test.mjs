import test from 'node:test';
import assert from 'node:assert/strict';

import { retryOnlineRead } from '../src/lib/online-retry.ts';
import { createTauriRangeFetch } from '../src/lib/tauri-range-fetch.ts';

const SOURCE = 'http://127.0.0.1:39209/read/resource/10.epub?revision=safe';

test('raw Tauri range bridge forwards Range without browser Request normalization', async () => {
  const calls = [];
  let bodyRead = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 7;
    if (command === 'plugin:http|fetch_send') {
      return {
        status: 206,
        statusText: 'Partial Content',
        url: SOURCE,
        headers: [
          ['content-type', 'application/epub+zip'],
          ['content-length', '1'],
          ['content-range', 'bytes 0-0/100'],
          ['etag', '"one"'],
        ],
        rid: 8,
      };
    }
    if (command === 'plugin:http|fetch_read_body') {
      bodyRead += 1;
      return bodyRead === 1 ? [0x50, 0] : [1];
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const response = await createTauriRangeFetch(invoke)(SOURCE, {
    method: 'GET',
    headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
  });

  assert.equal(response.status, 206);
  assert.equal(response.url, SOURCE);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0x50]));
  assert.deepEqual(calls[0], {
    command: 'plugin:http|fetch',
    args: {
      clientConfig: {
        method: 'GET',
        url: SOURCE,
        headers: [['Range', 'bytes=0-0'], ['Accept-Encoding', 'identity']],
        data: null,
        maxRedirections: 0,
        connectTimeout: 8000,
        proxy: null,
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      },
    },
  });
  assert.equal(calls.filter(({ command }) => command === 'plugin:http|fetch_read_body').length, 2);
});

test('raw Tauri range bridge cancels full bodies without reading them', async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 10;
    if (command === 'plugin:http|fetch_send') {
      return {
        status: 200,
        statusText: 'OK',
        url: SOURCE,
        headers: [['content-length', '1000000']],
        rid: 11,
      };
    }
    if (command === 'plugin:http|fetch_cancel_body') return undefined;
    throw new Error(`unexpected command: ${command}`);
  };

  const response = await createTauriRangeFetch(invoke)(SOURCE, {
    headers: { Range: 'bytes=0-0' },
  });
  await response.body.cancel();
  await Promise.resolve();

  assert.equal(calls.some(({ command }) => command === 'plugin:http|fetch_read_body'), false);
  assert.equal(calls.some(({ command, args }) => command === 'plugin:http|fetch_cancel_body' && args.rid === 11), true);
});

test('raw Tauri range bridge cancels a response that arrives after abort', async () => {
  const calls = [];
  let resolveSend;
  const send = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 12;
    if (command === 'plugin:http|fetch_send') return send;
    if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') {
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  };
  const controller = new AbortController();
  const pending = createTauriRangeFetch(invoke)(SOURCE, {
    headers: { Range: 'bytes=0-0' },
    signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  resolveSend({
    status: 206,
    statusText: 'Partial Content',
    url: SOURCE,
    headers: [],
    rid: 13,
  });

  await assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(
    calls.some(({ command, args }) => command === 'plugin:http|fetch_cancel_body' && args.rid === 13),
    true,
  );
});

test('raw Tauri range bridge rejects non-range headers and an already aborted request', async () => {
  let invoked = false;
  const fetch = createTauriRangeFetch(async () => {
    invoked = true;
    return 0;
  });

  await assert.rejects(fetch(SOURCE, { headers: { Authorization: 'secret' } }), /online.request_invalid/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetch(SOURCE, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(invoked, false);
});

for (const blockedStage of ['create', 'headers', 'body-read']) {
  test(`range timeout reports ${blockedStage} without leaking request or native data`, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const metadata = {
      status: 206, statusText: 'Partial Content', url: SOURCE,
      headers: [['content-length', '1']], rid: 21,
    };
    const invoke = async (command) => {
      calls.push(command);
      if (command === 'plugin:http|fetch') return blockedStage === 'create' ? gate : 20;
      if (command === 'plugin:http|fetch_send') return blockedStage === 'headers' ? gate : metadata;
      if (command === 'plugin:http|fetch_read_body') return gate;
      return undefined;
    };
    await assert.rejects(retryOnlineRead(async (signal) => {
      const response = await createTauriRangeFetch(invoke)(SOURCE, {
        headers: { Range: 'bytes=0-0' }, signal,
      });
      return response.arrayBuffer();
    }, () => false, new AbortController().signal, 10), { name: 'TimeoutError' });
    const logs = warnings.mock.calls.map(({ arguments: args }) => args[0]);
    const report = JSON.parse(logs.find((line) => line.startsWith('[online-range] ')).slice(15));
    assert.equal(report.stage, blockedStage);
    assert.equal(report.reason, 'timeout');
    assert.equal(report.range, 'bytes=0-0');
    assert.equal(report.receivedBytes, 0);
    assert.equal(report.status, blockedStage === 'body-read' ? 206 : null);
    assert.equal(logs.join('').includes(SOURCE), false);
    assert.equal(logs.join('').includes('revision='), false);
    release(blockedStage === 'create' ? 20 : blockedStage === 'headers' ? metadata : [1]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some((command) => command.startsWith('plugin:http|fetch_cancel')), true);
  });
}

test('raw Tauri range bridge skips empty nonterminal native chunks until EOF', async () => {
  const chunks = [[0], [0x50, 0], [0], [0x4b, 0], [0], [1]];
  const invoke = async (command) => {
    if (command === 'plugin:http|fetch') return 30;
    if (command === 'plugin:http|fetch_send') return {
      status: 206, statusText: 'Partial Content', url: SOURCE,
      headers: [['content-length', '2']], rid: 31,
    };
    if (command === 'plugin:http|fetch_read_body') return chunks.shift();
    return undefined;
  };
  const body = await retryOnlineRead(async (signal) => {
    const response = await createTauriRangeFetch(invoke)(SOURCE, {
      headers: { Range: 'bytes=0-1' }, signal,
    });
    return response.arrayBuffer();
  }, () => false, new AbortController().signal, 200);
  assert.deepEqual(new Uint8Array(body), new Uint8Array([0x50, 0x4b]));
  assert.equal(chunks.length, 0);
});
