import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeHttpRequest } from '../src/lib/native-http.ts';
import { NativeConnectionError } from '../src/lib/native-connection.ts';

const url = 'https://books.example/team/books/api/user/info';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const frame = (text) => [...new TextEncoder().encode(text), 0];

function fixture(overrides = {}) {
  const events = [];
  const counts = { dispatch: 0, settle: 0, uncertain: 0 };
  const chunks = [frame('hello'), [1]];
  const lifecycle = {
    async dispatch() { counts.dispatch++; events.push('dispatch'); },
    async settle() { counts.settle++; events.push('settle'); },
    uncertain() { counts.uncertain++; events.push('uncertain'); },
  };
  const invoke = async (command, args) => {
    events.push({ command, args });
    if (overrides[command]) return overrides[command](args);
    switch (command) {
      case 'plugin:http|fetch': return 7;
      case 'plugin:http|fetch_send': return {
        status: 200, statusText: 'OK', url, headers: [['x-fixture', 'yes'], ['set-cookie', 'fixture=1']], rid: 8,
      };
      case 'plugin:http|fetch_read_body': return chunks.shift();
      case 'plugin:http|fetch_cancel':
      case 'plugin:http|fetch_cancel_body': return;
      default: throw new Error(`Unexpected command ${command}`);
    }
  };
  return { lifecycle, invoke, events, counts };
}

test('preparation and dispatch finish before HTTP; options and encoded body are preserved', async () => {
  const f = fixture();
  const dispatch = deferred();
  f.lifecycle.dispatch = async () => { f.counts.dispatch++; f.events.push('dispatch'); await dispatch.promise; };
  const options = {
    method: 'POST', body: new URLSearchParams({ invite_code: '空 格&' }),
    headers: { 'x-source': 'original' }, maxRedirections: 0, connectTimeout: 1800,
    proxy: { https: { url: 'http://127.0.0.1:18445', noProxy: 'localhost' } },
    danger: { acceptInvalidCerts: false, acceptInvalidHostnames: false },
  };
  const result = nativeHttpRequest(url, options, f.lifecycle, f.invoke);
  await tick();
  assert.deepEqual(f.events, ['dispatch']);
  dispatch.resolve();
  const response = await result;
  const config = f.events[1].args.clientConfig;
  assert.equal(config.url, url);
  assert.equal(config.method, 'POST');
  assert.equal(config.maxRedirections, 0);
  assert.equal(config.connectTimeout, 1800);
  assert.deepEqual(config.proxy, options.proxy, 'advanced transport options reach plugin-http');
  assert.deepEqual(config.danger, options.danger);
  assert.match(new TextDecoder().decode(Uint8Array.from(config.data)), /invite_code=/);
  assert.deepEqual(config.headers, [['content-type', 'application/x-www-form-urlencoded;charset=UTF-8'], ['x-source', 'original']]);
  assert.equal(options.maxRedirections, 0, 'caller options are never mutated');
  assert.deepEqual(options.proxy, { https: { url: 'http://127.0.0.1:18445', noProxy: 'localhost' } });
  assert.equal(f.counts.settle, 0, 'headers alone are not transport completion');
  assert.equal(await response.text(), 'hello');
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('pre-aborted signal performs no dispatch, HTTP, or settlement', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke), { name: 'AbortError' });
  assert.deepEqual(f.events, []);
});

test('abort during request-body preparation cannot register or start native HTTP', async () => {
  const f = fixture();
  const controller = new AbortController();
  let body;
  const stream = new ReadableStream({ start(value) { body = value; } });
  const result = nativeHttpRequest(url, {
    method: 'POST', body: stream, duplex: 'half', signal: controller.signal,
  }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  body.enqueue(new TextEncoder().encode('prepared after abort'));
  body.close();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(f.events, []);
});

test('abort while dispatch is pending settles only after registration, without plugin HTTP', async () => {
  const f = fixture();
  const dispatch = deferred();
  const controller = new AbortController();
  f.lifecycle.dispatch = async () => { f.counts.dispatch++; await dispatch.promise; };
  const result = nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  assert.equal(f.counts.settle, 0);
  dispatch.resolve();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
  assert.equal(f.events.filter((event) => typeof event === 'object').length, 0);
});

test('abort while fetch creates its resource drains send and waits for confirmed native cancel', async () => {
  const rid = deferred();
  const cancel = deferred();
  const controller = new AbortController();
  const f = fixture({
    'plugin:http|fetch': () => rid.promise,
    'plugin:http|fetch_cancel': () => cancel.promise,
    'plugin:http|fetch_send': async () => { throw 'Request canceled'; },
  });
  const result = nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  rid.resolve(7);
  await tick();
  assert.equal(f.counts.settle, 0);
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_send').length, 1);
  cancel.resolve();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('request cancel acknowledgment cannot release a still-pending send', async () => {
  const send = deferred();
  const controller = new AbortController();
  const f = fixture({ 'plugin:http|fetch_send': () => send.promise });
  const result = nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  await tick();
  assert.equal(f.counts.settle, 0);
  send.reject('Request canceled');
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(f.counts.settle, 1);
});

test('racing response after abort is dropped before settlement', async () => {
  const send = deferred();
  const close = deferred();
  const controller = new AbortController();
  const f = fixture({
    'plugin:http|fetch_send': () => send.promise,
    'plugin:http|fetch_cancel_body': () => close.promise,
  });
  const result = nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  send.resolve({ status: 200, statusText: 'OK', url, headers: [], rid: 9 });
  await tick();
  assert.equal(f.counts.settle, 0);
  assert.deepEqual(f.events.find((event) => event.command === 'plugin:http|fetch_cancel_body').args, { rid: 9 });
  close.resolve();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('consumer cancellation awaits native body drop and settles exactly once', async () => {
  const close = deferred();
  const f = fixture({ 'plugin:http|fetch_cancel_body': () => close.promise });
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  const result = response.body.cancel();
  await tick();
  assert.equal(f.counts.settle, 0);
  close.resolve();
  await result;
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('idle-body signal cancellation is awaited and leaves the returned response unreadable', async () => {
  const close = deferred();
  const controller = new AbortController();
  const f = fixture({ 'plugin:http|fetch_cancel_body': () => close.promise });
  const response = await nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  controller.abort();
  await tick();
  assert.equal(f.counts.settle, 0);
  close.resolve();
  await tick();
  await assert.rejects(response.text(), { name: 'AbortError' });
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('abort during a native read awaits both the resource drop and outstanding Arc read', async () => {
  const read = deferred();
  const close = deferred();
  const controller = new AbortController();
  const f = fixture({
    'plugin:http|fetch_read_body': () => read.promise,
    'plugin:http|fetch_cancel_body': () => close.promise,
  });
  const response = await nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  const text = response.text();
  await tick();
  controller.abort();
  close.resolve();
  await tick();
  assert.equal(f.counts.settle, 0, 'resource-table close does not prove pending IO ended');
  read.resolve(frame('late'));
  await assert.rejects(text, { name: 'AbortError' });
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('recursive clones retain URL and headers while sharing one native body/settlement', async () => {
  const f = fixture();
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  const clone = response.clone();
  const nested = clone.clone();
  for (const current of [response, clone, nested]) {
    assert.equal(current.url, url);
    assert.equal(current.headers.get('x-fixture'), 'yes');
    assert.equal(current.headers.get('set-cookie'), 'fixture=1');
  }
  assert.deepEqual(await Promise.all([response.text(), clone.text(), nested.text()]), ['hello', 'hello', 'hello']);
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_read_body').length, 2);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

test('null-body responses explicitly release the native response before returning', async () => {
  const close = deferred();
  const f = fixture({
    'plugin:http|fetch_send': async () => ({ status: 204, statusText: 'No Content', url, headers: [], rid: 8 }),
    'plugin:http|fetch_cancel_body': () => close.promise,
  });
  const result = nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  await tick();
  assert.equal(f.counts.settle, 0);
  close.resolve();
  assert.equal((await result).body, null);
  assert.equal(f.counts.settle, 1);
});

test('HEAD 200 awaits native resource drop and host settlement before returning a null body', async () => {
  const close = deferred();
  const finish = deferred();
  const f = fixture({ 'plugin:http|fetch_cancel_body': () => close.promise });
  f.lifecycle.settle = async () => { f.counts.settle++; await finish.promise; };
  let returned = false;
  const result = nativeHttpRequest(url, {
    method: 'HEAD', maxRedirections: 0,
    danger: { acceptInvalidCerts: false, acceptInvalidHostnames: false },
  }, f.lifecycle, f.invoke).then((response) => { returned = true; return response; });
  await tick();
  const config = f.events.find((event) => event.command === 'plugin:http|fetch').args.clientConfig;
  assert.equal(config.method, 'HEAD');
  assert.equal(config.maxRedirections, 0);
  assert.deepEqual(config.danger, { acceptInvalidCerts: false, acceptInvalidHostnames: false });
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_read_body').length, 0);
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_cancel_body').length, 1);
  assert.equal(f.counts.settle, 0, 'HEAD resource must finish dropping first');
  assert.equal(returned, false);
  close.resolve();
  await tick();
  assert.equal(f.counts.settle, 1);
  assert.equal(returned, false, 'HEAD still awaits the authority acknowledgement');
  finish.resolve();
  const response = await result;
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('x-fixture'), 'yes');
  assert.equal(response.url, url);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 0 });
});

for (const stage of ['dispatch', 'plugin:http|fetch', 'plugin:http|fetch_send']) {
  test(`${stage} rejection retains an uncertain lease instead of settling`, async () => {
    const f = fixture({ [stage]: async () => { throw new Error('lost IPC'); } });
    if (stage === 'dispatch') f.lifecycle.dispatch = async () => { f.counts.dispatch++; throw new Error('lost IPC'); };
    await assert.rejects(nativeHttpRequest(url, {}, f.lifecycle, f.invoke), /lost IPC/);
    assert.equal(f.counts.settle, 0);
    assert.equal(f.counts.uncertain, 1);
  });
}

test('confirmed authority rejection before dispatch preserves the old session without HTTP or uncertainty', async () => {
  const f = fixture();
  const rejected = new NativeConnectionError('source_busy');
  assert.equal(rejected.code, 'source-in-use');
  f.lifecycle.dispatch = async () => { f.counts.dispatch++; throw rejected; };
  await assert.rejects(nativeHttpRequest(url, {}, f.lifecycle, f.invoke), (error) => error === rejected);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 0 });
  assert.deepEqual(f.events, [], 'a rejected registration never reaches plugin HTTP');
});

test('authority-uncertain dispatch rejection keeps the gate closed without HTTP', async () => {
  const f = fixture();
  const rejected = new NativeConnectionError('ipc_unknown', true);
  f.lifecycle.dispatch = async () => { f.counts.dispatch++; throw rejected; };
  await assert.rejects(nativeHttpRequest(url, {}, f.lifecycle, f.invoke), (error) => error === rejected);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
  assert.equal(f.events.filter((event) => typeof event === 'object').length, 0);
});

test('a plain source-in-use error string cannot be mistaken for a confirmed authority rejection', async () => {
  const f = fixture();
  f.lifecycle.dispatch = async () => { f.counts.dispatch++; throw 'source-in-use'; };
  await assert.rejects(nativeHttpRequest(url, {}, f.lifecycle, f.invoke), (error) => error === 'source-in-use');
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
});

test('ordinary send network errors remain uncertain without a typed native terminal envelope', async () => {
  const f = fixture({ 'plugin:http|fetch_send': async () => { throw 'error sending request: Connection refused'; } });
  await assert.rejects(nativeHttpRequest(url, {}, f.lifecycle, f.invoke), (error) => String(error).includes('Connection refused'));
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
});

test('failed request cancellation never settles, even when send reports cancellation', async () => {
  const send = deferred();
  const controller = new AbortController();
  const f = fixture({
    'plugin:http|fetch_send': () => send.promise,
    'plugin:http|fetch_cancel': async () => { throw new Error('cancel IPC lost'); },
  });
  const result = nativeHttpRequest(url, { signal: controller.signal }, f.lifecycle, f.invoke);
  await tick();
  controller.abort();
  send.reject('Request canceled');
  await assert.rejects(result, /cancel IPC lost/);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
});

test('failed body cancellation rejects and retains uncertainty without blind cleanup retry', async () => {
  const f = fixture({ 'plugin:http|fetch_cancel_body': async () => { throw new Error('body IPC lost'); } });
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  await assert.rejects(response.body.cancel(), /body IPC lost/);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_cancel_body').length, 1);
});

test('failed body read awaits cleanup but cannot prove settlement', async () => {
  const f = fixture({ 'plugin:http|fetch_read_body': async () => { throw new Error('read IPC lost'); } });
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  await assert.rejects(response.text(), /read IPC lost/);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
  assert.equal(f.events.filter((event) => event.command === 'plugin:http|fetch_cancel_body').length, 1);
});

test('a malformed body frame retains uncertainty', async () => {
  const f = fixture({ 'plugin:http|fetch_read_body': async () => [] });
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  await assert.rejects(response.text(), /Invalid native HTTP body frame/);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 0, uncertain: 1 });
});

test('failed host settlement is attempted once and keeps authority uncertain', async () => {
  const f = fixture();
  f.lifecycle.settle = async () => { f.counts.settle++; throw new Error('host finish lost'); };
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  await assert.rejects(response.text(), /host finish lost/);
  assert.deepEqual(f.counts, { dispatch: 1, settle: 1, uncertain: 1 });
});

test('an otherwise complete body is not exposed as complete before host settlement acknowledges', async () => {
  const finish = deferred();
  const f = fixture();
  f.lifecycle.settle = async () => { f.counts.settle++; await finish.promise; };
  const response = await nativeHttpRequest(url, {}, f.lifecycle, f.invoke);
  let completed = false;
  const text = response.text().then((value) => { completed = true; return value; });
  await tick();
  assert.equal(f.counts.settle, 1);
  assert.equal(completed, false);
  finish.resolve();
  assert.equal(await text, 'hello');
  assert.equal(completed, true);
});
