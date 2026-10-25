import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { DEFAULT_SERVER_CAPABILITIES, useServerStore } from '../src/lib/store/server.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const guest = () => json({ err: 'ok', user: { is_login: false } });
const reader = (id = 7) => ({ id, username: `reader-${id}`, name: '测试读者', email: '', avatar: '', admin: false, permission: '' });
const signedIn = (id = 7) => json({ err: 'ok', user: { ...reader(id), is_login: true }, sys: { title: '测试书库' } });
let moduleId = 0;

for (const stage of ['request', 'body']) {
  test(`shared info timeout bounds ${stage}, aborts transport and ignores late completion during retry`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const old = Promise.withResolvers();
    const fresh = Promise.withResolvers();
    const calls = [];
    const lateResponse = signedIn(99);
    const cancel = t.mock.method(lateResponse.body, 'cancel');
    if (stage === 'body') lateResponse.text = () => old.promise;
    const api = await installApi(t, async (url, init) => {
      if (!url.endsWith('/api/user/info')) return json({ err: 'ok', books: [] });
      calls.push(init);
      return calls.length === 1 ? (stage === 'body' ? lateResponse : old.promise) : fresh.promise;
    });
    let settled = false;
    const pending = Promise.allSettled([api.fetchCurrentUser(), api.fetchServerInfo(), api.discoverServerCapabilities('https://books.test')]).then(results => { settled = true; return results; });
    await tick();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(15_000);
    await tick();
    assert.equal(settled, true, 'hung shared work must settle at the deadline');
    const results = await pending;
    assert.ok(results.slice(0, 2).every(result => result.status === 'rejected' && result.reason.name === 'TimeoutError'));
    assert.equal(calls[0].signal.aborted, true);
    const retry = api.fetchCurrentUser();
    await tick();
    assert.equal(calls.length, 2);
    old.resolve(stage === 'body' ? JSON.stringify({ err: 'ok', user: { ...reader(99), is_login: true } }) : lateResponse);
    await tick();
    const sharedRetry = api.fetchCurrentUser();
    await tick();
    assert.equal(calls.length, 2, 'late work must not delete the retry entry');
    if (stage === 'request') assert.equal(cancel.mock.callCount(), 1);
    fresh.resolve(signedIn());
    assert.equal((await retry).user.id, 7);
    assert.equal((await sharedRetry).user.id, 7);
    t.mock.timers.tick(15_000);
    assert.equal(calls[1].signal.aborted, false, 'a settled request must clear its timer');
  });
}

async function installApi(t, fetch) {
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  useServerStore.getState().setServer('https', 'books.test', '');
  t.after(() => useServerStore.getState().disconnect());
  t.mock.method(globalThis, 'fetch', fetch);
  return import(`../src/lib/api.ts?user-info-test=${moduleId++}`);
}

test('normal same-session user, title and capability probes share one body; settled results are not cached', async (t) => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const api = await installApi(t, async (url) => {
    if (!url.endsWith('/api/user/info')) return json({ err: 'ok', books: [] });
    calls++;
    return calls === 1 ? gate.promise : signedIn();
  });
  const probes = [api.fetchCurrentUser(), api.fetchServerInfo(), api.discoverServerCapabilities('https://books.test')];
  await tick();
  assert.equal(calls, 1);
  const response = signedIn();
  const read = t.mock.method(response, 'text');
  gate.resolve(response);
  const [user, server] = await Promise.all(probes);
  assert.equal(user.user.id, 7);
  assert.equal(server.title, '测试书库');
  assert.equal(read.mock.callCount(), 1);
  await api.fetchCurrentUser();
  assert.equal(calls, 2);
});

for (const [body, userMessage, serverMessage] of [
  ['<html>invalid JSON</html>', '登录状态响应无效。', '服务器返回内容无效。'],
  ['', '登录状态响应无效。', '服务器返回内容无效。'],
  ['invalid JSON', '登录状态响应无效：invalid JSON', '服务器返回内容无效：invalid JSON'],
]) {
  test(`shared invalid JSON preserves consumer-specific messages (${JSON.stringify(body)})`, async (t) => {
    const gate = Promise.withResolvers();
    let calls = 0;
    const api = await installApi(t, async () => { calls++; return gate.promise; });
    const results = Promise.allSettled([api.fetchCurrentUser(), api.fetchServerInfo()]);
    await tick();
    assert.equal(calls, 1);
    const response = new Response(body);
    const read = t.mock.method(response, 'text');
    gate.resolve(response);
    const [user, server] = await results;
    assert.equal(user.status, 'rejected');
    assert.equal(server.status, 'rejected');
    assert.equal(user.reason.code, 'server.invalid_response');
    assert.equal(user.reason.status, 200);
    assert.equal(user.reason.message, userMessage);
    assert.equal(server.reason.code, 'server.invalid_response');
    assert.equal(server.reason.status, 200);
    assert.equal(server.reason.message, serverMessage);
    assert.notEqual(user.reason, server.reason, 'consumer mapping must not mutate the shared parse error');
    assert.equal(read.mock.callCount(), 1);
  });
}

for (const failure of ['network', 'body', 'http']) {
  test(`current-user JSON message mapping preserves ${failure} failures`, async (t) => {
    const gate = Promise.withResolvers();
    const networkError = new Error('transport unavailable');
    const api = await installApi(t, async () => gate.promise);
    const results = Promise.allSettled([api.fetchCurrentUser(), api.fetchServerInfo()]);
    await tick();
    if (failure === 'network') gate.reject(networkError);
    else {
      const response = failure === 'http'
        ? new Response('<html>Unauthorized</html>', { status: 401 })
        : new Response('');
      if (failure === 'body') response.text = async () => { throw new Error('body unavailable'); };
      gate.resolve(response);
    }
    const [user, server] = await results;
    assert.equal(user.status, 'rejected');
    assert.equal(server.status, 'rejected');
    assert.equal(user.reason, server.reason, 'unrelated errors must pass through unchanged');
    if (failure === 'network') assert.equal(user.reason, networkError);
    if (failure === 'body') {
      assert.equal(user.reason.code, 'server.response_read_failed');
      assert.equal(user.reason.message, '服务器响应读取失败，请稍后重试。');
    }
    if (failure === 'http') {
      assert.equal(user.reason.code, 'http.401');
      assert.equal(user.reason.status, 401);
      assert.equal(user.reason.message, '服务器返回 401，且响应内容无效。');
    }
  });
}

test('successful sign-in isolates suspended anonymous info before confirmation and invalidates old capabilities/covers', async (t) => {
  const anonymous = Promise.withResolvers();
  const confirmed = Promise.withResolvers();
  let infoCalls = 0;
  const api = await installApi(t, async (url) => {
    if (url.endsWith('/api/user/sign_in')) return json({ err: 'ok' });
    if (url.endsWith('/cover.png')) return new Response(new Blob(['cover'], { type: 'image/png' }));
    infoCalls++;
    return infoCalls === 1 ? anonymous.promise : confirmed.promise;
  });
  const previous = useServerStore.getState().sessionRevision;
  const oldCover = await api.acquireImageObjectUrl('https://books.test/cover.png', previous);
  t.after(() => api.releaseImageObjectUrl('https://books.test/cover.png', previous));
  const oldUser = api.fetchCurrentUser();
  await tick();
  useServerStore.setState({ capabilities: { ...DEFAULT_SERVER_CAPABILITIES, checkedAt: Date.now(), annotationApiStatus: 'supported', annotationApiCheckedAt: Date.now() } });
  assert.equal((await (await api.request('https://books.test/api/user/sign_in', { method: 'POST', credentials: 'include' })).json()).err, 'ok');
  useServerStore.getState().invalidateSession();
  const pending = useServerStore.getState();
  assert.equal(pending.sessionRevision, previous + 1);
  assert.equal(pending.user, null);
  assert.equal(pending.token, '');
  assert.equal(pending.capabilities.checkedAt, null);
  assert.equal(pending.capabilities.annotationApiStatus, 'unchecked');
  assert.equal(pending.capabilities.annotationApiCheckedAt, null);
  assert.equal(api.getCachedImageObjectUrl('https://books.test/cover.png', pending.sessionRevision), null);
  const newUser = api.fetchCurrentUser();
  const newTitle = api.fetchServerInfo();
  await tick();
  assert.equal(infoCalls, 2);
  confirmed.resolve(signedIn());
  const result = await newUser;
  useServerStore.getState().setConnected('', result.user);
  assert.equal((await newTitle).title, '测试书库');
  anonymous.resolve(guest());
  assert.equal((await oldUser).isLogin, false);
  assert.equal(useServerStore.getState().user.id, 7);
  const currentRevision = useServerStore.getState().sessionRevision;
  const newCover = await api.acquireImageObjectUrl('https://books.test/cover.png', currentRevision);
  t.after(() => api.releaseImageObjectUrl('https://books.test/cover.png', currentRevision));
  assert.notEqual(newCover, oldCover);
});

for (const transition of ['credentials', 'server', 'account', 'logout']) {
  test(`${transition} separates pending info; old completion cannot delete the new shared task`, async (t) => {
    const old = Promise.withResolvers();
    const fresh = Promise.withResolvers();
    const calls = [];
    const api = await installApi(t, async (url) => {
      calls.push(url);
      return calls.length === 1 ? old.promise : fresh.promise;
    });
    const previous = api.fetchCurrentUser();
    await tick();
    if (transition === 'credentials') useServerStore.getState().invalidateSession();
    if (transition === 'server') useServerStore.getState().setServer('https', 'other.books.test', '');
    if (transition === 'account') useServerStore.getState().setConnected('', reader(8));
    if (transition === 'logout') useServerStore.getState().logout();
    const current = api.fetchCurrentUser();
    await tick();
    assert.equal(calls.length, 2);
    if (transition === 'server') assert.equal(calls[1], 'https://other.books.test/api/user/info');
    old.resolve(guest());
    await previous;
    const alsoCurrent = api.fetchCurrentUser();
    await tick();
    assert.equal(calls.length, 2);
    fresh.resolve(signedIn(8));
    assert.equal((await current).user.id, 8);
    assert.equal((await alsoCurrent).user.id, 8);
  });
}

for (const failure of ['network', 'json', 'business']) {
  test(`${failure} failure is shared only while pending and permits retry`, async (t) => {
    const gate = Promise.withResolvers();
    let calls = 0;
    const api = await installApi(t, async () => {
      calls++;
      return calls === 1 ? gate.promise : signedIn();
    });
    const first = api.fetchCurrentUser();
    const second = api.fetchCurrentUser();
    const failed = Promise.allSettled([first, second]);
    await tick();
    assert.equal(calls, 1);
    if (failure === 'network') gate.reject(new Error('simulated network failure'));
    if (failure === 'json') gate.resolve(new Response('invalid JSON'));
    if (failure === 'business') gate.resolve(json({ err: 'server.busy' }));
    assert.ok((await failed).every((result) => result.status === 'rejected'));
    assert.equal((await api.fetchCurrentUser()).user.id, 7);
    assert.equal(calls, 2);
  });
}
