import test from 'node:test';
import assert from 'node:assert/strict';

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
