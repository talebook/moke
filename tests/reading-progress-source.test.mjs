import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
import { DEFAULT_SERVER_CAPABILITIES } from '../src/lib/server-capabilities.ts';
import { MokeApiError } from '../src/lib/api-core.ts';
import { useServerStore } from '../src/lib/store/server.ts';
const { fetchReadingProgress, saveReadingProgress } = await import('../src/lib/reading-progress.ts');

const a = 'https://a.test', b = 'https://b.test';
const progress = {schema:'moke.readest.progress.v1',reader:'readest',moke_book_id:'42',location:'fixture',updated_at:'2026-10-11T00:00:00Z'};
const unsupported = () => Response.json({err:'api.not_found'}, {status:404});
const call = (kind, source = a, signal) => kind === 'fetch'
  ? fetchReadingProgress('42', signal, source) : saveReadingProgress('42', progress, source, signal);

function installSource(context, capabilities = {}) {
  const previous = useServerStore.getState();
  context.after(() => useServerStore.setState(previous, true));
  useServerStore.setState({serverUrl:a,connectionId:1,sessionId:1,
    capabilities:{...DEFAULT_SERVER_CAPABILITIES,readingProgressApi:true,...capabilities}});
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve=done;reject=fail;});
  return {promise,resolve,reject};
}

for (const kind of ['fetch','save']) {
  test(`${kind} uses an unverified cross-source default without borrowing active unsupported capabilities`, async context => {
    installSource(context, {readingProgressApi:false,checkedAt:123});
    const calls = [], capabilities = useServerStore.getState().capabilities;
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({url:String(url),init});
      return Response.json({err:'ok',progress});
    });
    assert.equal(await call(kind), kind === 'fetch' ? null : undefined);
    assert.equal(calls.length, 0);
    const result = await call(kind, b);
    assert.deepEqual(result, kind === 'fetch' ? progress : undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${b}/api/book/42/progress`);
    assert.equal(calls[0].init.credentials, 'include');
    if (kind === 'save') assert.deepEqual(JSON.parse(calls[0].init.body), {progress});
    assert.equal(useServerStore.getState().capabilities, capabilities);
  });

  test(`${kind} marks a confirmed unsupported endpoint only in the current source session`, async context => {
    installSource(context);
    context.mock.method(globalThis, 'fetch', async () => unsupported());
    await call(kind);
    assert.equal(useServerStore.getState().capabilities.readingProgressApi, false);
    assert.ok(useServerStore.getState().capabilities.checkedAt > 0);
  });

  test(`${kind} never applies a different source's unsupported result to the active server`, async context => {
    installSource(context);
    const capabilities = useServerStore.getState().capabilities;
    context.mock.method(globalThis, 'fetch', async () => unsupported());
    await call(kind, b);
    assert.equal(useServerStore.getState().capabilities, capabilities);
  });

  test(`${kind} starts no request when its optional signal is already aborted`, async context => {
    installSource(context);
    const abort = new AbortController(); abort.abort();
    context.mock.method(globalThis, 'fetch', async () => assert.fail('aborted progress must not fetch'));
    await call(kind, a, abort.signal);
    assert.equal(useServerStore.getState().capabilities.readingProgressApi, true);
  });

  test(`${kind} passes its signal and ignores a late unsupported response after cancellation`, async context => {
    installSource(context);
    const entered = deferred(), pending = deferred(), abort = new AbortController();
    const capabilities = useServerStore.getState().capabilities;
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.signal, abort.signal); entered.resolve(); return pending.promise;
    });
    const result = call(kind, a, abort.signal);
    await entered.promise;
    abort.abort(new Error('fixture deadline'));
    pending.resolve(unsupported());
    await result;
    assert.equal(useServerStore.getState().capabilities, capabilities);
  });

  test(`${kind} ignores a response body that finishes after cancellation`, async context => {
    installSource(context);
    const entered = deferred(), pending = deferred(), abort = new AbortController();
    const capabilities = useServerStore.getState().capabilities;
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.signal, abort.signal);
      return new Response(new ReadableStream({async pull(controller) {
        entered.resolve(); await pending.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({err:'ok',progress})));
        controller.close();
      }}, {highWaterMark:0}), {headers:{'Content-Type':'application/json'}});
    });
    const result = call(kind, a, abort.signal);
    await entered.promise;
    abort.abort(); pending.resolve();
    assert.equal(await result, kind === 'fetch' ? null : undefined);
    assert.equal(useServerStore.getState().capabilities, capabilities);
  });

  for (const change of ['connection','session']) for (const outcome of ['response','error']) {
    test(`late ${kind} unsupported ${outcome} cannot alter a new same-URL ${change}`, async context => {
      installSource(context);
      const entered = deferred(), pending = deferred();
      context.mock.method(globalThis, 'fetch', async () => {entered.resolve();return pending.promise;});
      const result = call(kind);
      await entered.promise;
      const capabilities = {...DEFAULT_SERVER_CAPABILITIES,readingProgressApi:true,checkedAt:456,version:'current'};
      useServerStore.setState({[change === 'connection' ? 'connectionId' : 'sessionId']:2,capabilities});
      if (outcome === 'response') pending.resolve(unsupported());
      else pending.reject(new MokeApiError('fixture obsolete endpoint', 'api.not_found', 404));
      await result;
      assert.equal(useServerStore.getState().serverUrl, a);
      assert.equal(useServerStore.getState().capabilities, capabilities);
    });
  }
}
