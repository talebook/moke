import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const response = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('saved access wrapper binds real persistence, candidate state and HTTP to one selected entry', { concurrency: false }, async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  const storage = new Map();
  const timers = new Set();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true, writable: true,
    value: { localStorage,
      setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
      clearTimeout,
    },
  });
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  let fetchHandler = () => { throw new Error('unplanned fixture request'); };
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init, method: init?.method ?? 'GET' };
    // These are reserved synthetic hosts. No real network request is made.
    assert.ok(call.url.startsWith('https://access-a.invalid/a/') || call.url.startsWith('https://access-b.invalid/b/'));
    calls.push(call);
    return fetchHandler(call);
  };

  const { saveServer, loadSavedServers } = await import('../src/lib/saved-server-api.ts');
  const { useServerStore } = await import('../src/lib/store/server.ts');
  const { savedServerConnection, submitSavedServerAccess } = await import('../src/lib/saved-server-connection.ts');
  t.after(() => {
    savedServerConnection.cancel();
    for (const timer of timers) clearTimeout(timer);
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  });

  const savedA = await saveServer({ rawBaseUrl: 'https://access-a.invalid/a', displayName: 'Fixture A' });
  const savedB = await saveServer({ rawBaseUrl: 'https://access-b.invalid/b', displayName: 'Fixture B' });
  assert.equal(savedA.ok, true);
  assert.equal(savedB.ok, true);
  assert.notEqual(savedA.server.id, savedB.server.id);

  async function entry(id) {
    const result = await loadSavedServers();
    assert.equal(result.ok, true);
    return result.savedServers.find((item) => item.id === id);
  }
  function reset() {
    savedServerConnection.cancel();
    useServerStore.getState().disconnect();
    calls.length = 0;
    const admitted = new Set();
    fetchHandler = ({ url, method }) => {
      if (url.endsWith('/api/user/info')) return response({ err: 'user.need_login' });
      if (url.endsWith('/api/welcome') && method === 'POST') { admitted.add(url); return response({ err: 'ok' }); }
      if (url.endsWith('/api/welcome')) return response({ err: admitted.has(url) ? 'free' : 'ok' });
      throw new Error('unexpected fixture route');
    };
    return admitted;
  }
  async function needsAccess(id) {
    const selected = await entry(id);
    const result = await savedServerConnection.connect(selected);
    assert.equal(result.code, 'access-required');
    assert.equal(result.entryId, id);
    assert.equal(result.entryRevision, selected.entryRevision);
    assert.equal(result.sessionRevision, useServerStore.getState().sessionRevision);
    return selected;
  }
  const posts = () => calls.filter((call) => call.method === 'POST');

  await t.test('record revision changed after the candidate probe refuses before any POST', async () => {
    reset();
    const original = await needsAccess(savedA.server.id);
    const renamed = await saveServer({ rawBaseUrl: original.url, displayName: 'Fixture renamed',
      target: { id: original.id, expectedEntryRevision: original.entryRevision } });
    assert.equal(renamed.ok, true);
    assert.notEqual(renamed.server.entryRevision, original.entryRevision);
    await assert.rejects(submitSavedServerAccess('fictional-code', undefined, new AbortController().signal), { message: 'candidate-changed' });
    assert.equal(posts().length, 0);
    assert.equal(useServerStore.getState().serverUrl, '');
  });

  await t.test('a changed authentication epoch cannot reuse the failed candidate for a POST', async () => {
    reset();
    await needsAccess(savedA.server.id);
    useServerStore.getState().invalidateSession();
    await assert.rejects(submitSavedServerAccess('fictional-code', undefined, new AbortController().signal), { message: 'candidate-changed' });
    assert.equal(posts().length, 0);
    assert.equal(useServerStore.getState().serverUrl, '');
  });

  await t.test('cancel of access-required invalidates its attempt and prevents later code submission', async () => {
    reset();
    await needsAccess(savedA.server.id);
    const oldAttempt = savedServerConnection.getState().attempt;
    const cancelled = savedServerConnection.cancel(oldAttempt);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.needsAccessCode, false);
    assert.notEqual(cancelled.attempt, oldAttempt);
    await assert.rejects(submitSavedServerAccess('fictional-code', undefined, new AbortController().signal), { message: 'candidate-unavailable' });
    assert.equal(posts().length, 0);
  });

  await t.test('correct form POST binds the full base and protects invite_code from captcha fields', async () => {
    reset();
    const selected = await needsAccess(savedA.server.id);
    const abort = new AbortController();
    const result = await submitSavedServerAccess('entered-fictional-code', {
      invite_code: 'must-not-replace-entered-code', captcha_code: 'fictional-captcha', provider: 'fixture',
    }, abort.signal);
    assert.equal(result.err, 'ok');
    assert.equal(result.connection.phase, 'connected');
    assert.equal(posts().length, 1);
    const post = posts()[0];
    assert.equal(post.url, `${selected.url}/api/welcome`);
    assert.ok(post.init.body instanceof URLSearchParams);
    assert.deepEqual(post.init.body.getAll('invite_code'), ['entered-fictional-code']);
    assert.equal(post.init.body.get('captcha_code'), 'fictional-captcha');
    assert.equal(post.init.credentials, 'include');
    assert.equal(post.init.redirect, 'error');
    assert.equal(post.init.maxRedirections, 0);
    assert.equal(post.init.signal, abort.signal);
    assert.equal(useServerStore.getState().serverUrl, selected.url);
    assert.equal(useServerStore.getState().savedServerId, selected.id);
    assert.equal(useServerStore.getState().user, null);
  });

  await t.test('string captcha remains a separate form field', async () => {
    reset();
    await needsAccess(savedA.server.id);
    const result = await submitSavedServerAccess('fictional-code', 'string-captcha', new AbortController().signal);
    assert.equal(result.connection.phase, 'connected');
    assert.equal(posts()[0].init.body.get('invite_code'), 'fictional-code');
    assert.equal(posts()[0].init.body.get('captcha_code'), 'string-captcha');
  });

  await t.test('aborting during the post-success re-probe cannot activate even if transport responds late', async () => {
    reset();
    await needsAccess(savedA.server.id);
    const retryStarted = deferred();
    const retryResponse = deferred();
    let posted = false;
    let retrySignal;
    fetchHandler = ({ url, method, init }) => {
      if (method === 'POST') { posted = true; return response({ err: 'ok' }); }
      if (posted && url.endsWith('/api/user/info')) {
        retrySignal = init.signal; retryStarted.resolve(); return retryResponse.promise;
      }
      return response({ err: 'free' });
    };
    const abort = new AbortController();
    const submitting = submitSavedServerAccess('fictional-code', undefined, abort.signal);
    await retryStarted.promise;
    abort.abort();
    const result = await submitting;
    assert.equal(retrySignal.aborted, true);
    assert.equal(result.connection.phase, 'cancelled');
    assert.equal(useServerStore.getState().serverUrl, '');
    retryResponse.resolve(response({ err: 'ok' }));
    await new Promise(setImmediate);
    assert.equal(useServerStore.getState().serverUrl, '');
    assert.equal(savedServerConnection.getState().phase, 'cancelled');
  });

  await t.test('a late A code response cannot replace a new B candidate or activate either entry', async () => {
    const admitted = reset();
    await needsAccess(savedA.server.id);
    const postedA = deferred();
    const responseA = deferred();
    const normalHandler = fetchHandler;
    fetchHandler = (call) => {
      if (call.method === 'POST' && call.url.startsWith(savedA.server.url)) {
        postedA.resolve(); return responseA.promise;
      }
      return normalHandler(call);
    };
    const staleSubmission = submitSavedServerAccess('fictional-code-a', undefined, new AbortController().signal);
    await postedA.promise;
    const selectedB = await needsAccess(savedB.server.id);
    admitted.add(`${savedA.server.url}/api/welcome`);
    responseA.resolve(response({ err: 'ok' }));
    await assert.rejects(staleSubmission, { message: 'candidate-changed' });
    assert.equal(useServerStore.getState().serverUrl, '');
    assert.equal(savedServerConnection.getState().entryId, selectedB.id);
    assert.equal(savedServerConnection.getState().code, 'access-required');
    const validB = await submitSavedServerAccess('fictional-code-b', undefined, new AbortController().signal);
    assert.equal(validB.connection.phase, 'connected');
    assert.equal(useServerStore.getState().serverUrl, selectedB.url);
    assert.deepEqual(posts().map((post) => post.url), [`${savedA.server.url}/api/welcome`, `${selectedB.url}/api/welcome`]);
  });

  await t.test('a fresh candidate in the new session can submit independently after rejecting the old epoch', async () => {
    reset();
    await needsAccess(savedA.server.id);
    const previous = savedServerConnection.getState();
    useServerStore.getState().invalidateSession();
    const selected = await needsAccess(savedA.server.id);
    const current = savedServerConnection.getState();
    assert.notEqual(current.attempt, previous.attempt);
    assert.notEqual(current.sessionRevision, previous.sessionRevision);
    const result = await submitSavedServerAccess('fresh-fictional-code', undefined, new AbortController().signal);
    assert.equal(result.connection.phase, 'connected');
    assert.equal(useServerStore.getState().serverUrl, selected.url);
    assert.equal(posts().length, 1);
  });
});
