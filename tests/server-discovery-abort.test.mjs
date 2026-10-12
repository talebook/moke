import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
const { discoverServerCapabilities } = await import('../src/lib/api.ts');
const server = 'https://books.test';
const info = () => Response.json({err:'ok',sys:{version:'3.15.0'}});
const sample = () => Response.json({err:'ok',books:[{id:'42'}]});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve=done; reject=fail;});
  return {promise,resolve,reject};
}

test('capability discovery forwards cancellation through shared info and all later probes', async context => {
  const abort = new AbortController(), calls = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({path:new URL(url).pathname,signal:init.signal,credentials:init.credentials});
    if (calls.length===1) return info();
    if (calls.length===2) return sample();
    return Response.json({err:'ok'});
  });
  const result = await discoverServerCapabilities(server, abort.signal);
  assert.equal(result.version, '3.15.0');
  assert.equal(result.shelfApi, true);
  assert.equal(result.readingStateApi, true);
  assert.equal(result.readingProgressApi, true);
  assert.equal(result.annotationApiStatus, 'unchecked');
  assert.deepEqual(calls.map(call=>call.path), [
    '/api/user/info','/api/shelf','/api/shelf','/api/reading/stats',
    '/api/network/sources','/api/book/42/readstate','/api/book/42/progress',
  ]);
  for (const [index, call] of calls.entries()) {
    if (index === 0) {
      assert.ok(call.signal instanceof AbortSignal);
      assert.notEqual(call.signal, abort.signal, 'userinfo owns its timeout controller');
    } else assert.equal(call.signal, abort.signal);
    assert.equal(call.credentials, 'include');
  }
});

test('an already cancelled discovery starts no HTTP requests', async context => {
  const abort = new AbortController(), reason = new Error('cancelled before discovery');
  abort.abort(reason);
  context.mock.method(globalThis, 'fetch', async () => assert.fail('cancelled discovery must not fetch'));
  await assert.rejects(discoverServerCapabilities(server, abort.signal), error=>error===reason);
});

for (const stage of ['info','sample','sample-fallback']) {
  test(`cancellation during ${stage} stops later requests even when transport returns a late response`, async context => {
    const abort = new AbortController(), entered = deferred(), finish = deferred(), calls = [];
    const target = stage==='info' ? 1 : stage==='sample' ? 2 : 3;
    let infoTransport;
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) { infoTransport = init.signal; assert.notEqual(init.signal, abort.signal); }
      else assert.equal(init.signal, abort.signal);
      if (calls.length===target) {entered.resolve(); return finish.promise;}
      if (calls.length===1) return info();
      return Response.json({err:'page.not_found'}, {status:404});
    });
    const discovery = discoverServerCapabilities(server, abort.signal);
    await entered.promise;
    const reason = new Error(`cancelled during ${stage}`);
    abort.abort(reason);
    finish.resolve(stage==='info' ? info() : sample());
    await assert.rejects(discovery, error=>error===reason);
    assert.equal(calls.length, target);
    assert.equal(infoTransport.aborted, stage === 'info', 'only pending info must receive outer cancellation');
    if (stage==='sample-fallback') assert.ok(calls[2].endsWith('/api/library?num=1'));
  });
}

test('cancelling the probe fan-out aborts every pending request and preserves cancellation instead of false capabilities', async context => {
  const abort = new AbortController(), allStarted = deferred(), cancelled = [], calls = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) assert.notEqual(init.signal, abort.signal);
    else assert.equal(init.signal, abort.signal);
    if (calls.length===1) return info();
    if (calls.length===2) return sample();
    const waiting = new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      cancelled.push(String(url)); reject(init.signal.reason);
    }, {once:true}));
    if (calls.length===7) allStarted.resolve();
    return waiting;
  });
  const discovery = discoverServerCapabilities(server, abort.signal);
  await allStarted.promise;
  const reason = new Error('session changed during probe fan-out');
  abort.abort(reason);
  await assert.rejects(discovery, error=>error===reason);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length, 7);
  assert.deepEqual(cancelled.sort(), calls.slice(2).sort());
});

test('an info body arriving after cancellation cannot start sample or probe requests', async context => {
  const abort = new AbortController(), bodyStarted = deferred(), finishBody = deferred();
  let calls = 0, infoTransport;
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    infoTransport = init.signal;
    assert.notEqual(init.signal, abort.signal);
    return new Response(new ReadableStream({async start(controller) {
      bodyStarted.resolve();
      await finishBody.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({err:'ok',sys:{version:'3.15.0'}})));
      controller.close();
    }}), {headers:{'Content-Type':'application/json'}});
  });
  const discovery = discoverServerCapabilities(server, abort.signal);
  await bodyStarted.promise;
  const reason = new Error('cancelled while reading response body');
  abort.abort(reason);
  finishBody.resolve();
  await assert.rejects(discovery, error=>error===reason);
  assert.equal(calls, 1);
  assert.equal(infoTransport.aborted, true);
  assert.equal(infoTransport.reason, reason);
});
