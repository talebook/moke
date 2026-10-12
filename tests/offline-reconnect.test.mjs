import test from 'node:test';
import assert from 'node:assert/strict';
import { reconnectOfflineServer } from '../src/lib/offline-reconnect.ts';
import { useServerStore, DEFAULT_SERVER_CAPABILITIES } from '../src/lib/store/server.ts';
import { connectSavedServerFixture } from './helpers/saved-server-session.mjs';
import { registerReaderProgressFlush } from '../src/lib/reader-source.ts';

const SERVER = 'https://previous.books.test';
const USER = { id: 7, username: 'fixture-reader', name: '测试读者' };
const successApi = {
  checkAccess: async () => ({ err: 'ok', needsAccessCode: false }),
  fetchUser: async () => ({ err: 'ok', isLogin: true, user: USER }),
};
function offlineState() {
  useServerStore.setState({ serverUrl: SERVER, offlineMode: true, isConnected: false,
    token: 'fictional-token', user: USER, sessionRevision: 1, sessionId: 1, connectionId: 1,
    activeServerId: 'previous', candidate: null, hasHydrated: true, storageBusy: false, storageError: '', saving: false,
    savedServers: [{id:'previous',url:SERVER,title:'Previous',addedAt:''}],
    capabilities: { ...DEFAULT_SERVER_CAPABILITIES, checkedAt: Date.now() } });
}
test.beforeEach(offlineState);
test.afterEach(() => useServerStore.getState().disconnect());

test('恢复进入离线时的服务器，保留凭据并强制重新探测能力', async () => {
  const seen = [];
  const result = await reconnectOfflineServer({
    checkAccess: async (url) => { seen.push(url); return { err: 'ok', needsAccessCode: false }; },
    fetchUser: async (url) => { seen.push(url); return { err: 'ok', isLogin: true, user: USER }; },
  }, new AbortController().signal);
  assert.deepEqual(result, { target: '/shelf' });
  assert.deepEqual(seen, [SERVER, SERVER]);
  const state = useServerStore.getState();
  assert.equal(state.serverUrl, SERVER);
  assert.equal(state.offlineMode, false);
  assert.equal(state.isConnected, true);
  assert.equal(state.token, 'fictional-token');
  assert.equal(state.capabilities.checkedAt, null);
});

test('从无服务器的连接界面进入离线，退出时返回正常连接入口', async () => {
  useServerStore.setState({ serverUrl: '', user: null });
  const result = await reconnectOfflineServer({
    checkAccess: () => assert.fail('不能请求未知服务器'), fetchUser: () => assert.fail('不能请求未知服务器'),
  }, new AbortController().signal);
  assert.deepEqual(result, { target: '/welcome' });
  assert.equal(useServerStore.getState().offlineMode, false);
  assert.equal(useServerStore.getState().isConnected, false);
});

test('访问码失效时进入原服务器的访问码页面，保留会话', async () => {
  const result = await reconnectOfflineServer({
    checkAccess: async () => ({ err: 'ok', needsAccessCode: true }),
    fetchUser: () => assert.fail('访问码未验证前不能同步账户'),
  }, new AbortController().signal);
  assert.match(result.target, /^\/access\?serverId=previous&requestId=\d+$/);
  assert.equal(useServerStore.getState().candidate.needsAccessCode, true);
  assert.equal(useServerStore.getState().offlineMode, true);
  assert.strictEqual(useServerStore.getState().user, USER);
  assert.equal(useServerStore.getState().token, 'fictional-token');
});

test('仅确认失效的登录才清除旧用户并转到登录页；游客恢复书架', async () => {
  const guestApi = { ...successApi, fetchUser: async () => ({ err: 'user.need_login', isLogin: false, user: null }) };
  assert.deepEqual(await reconnectOfflineServer(guestApi, new AbortController().signal), { target: '/login?reconnect=1' });
  assert.equal(useServerStore.getState().user, null);
  offlineState();
  useServerStore.setState({ user: null });
  assert.deepEqual(await reconnectOfflineServer(guestApi, new AbortController().signal), { target: '/shelf' });
});

test('访问检查失败或网络失败时保留离线模式、服务器和凭据', async () => {
  for (const api of [
    { ...successApi, checkAccess: async () => ({ err: 'network.error', needsAccessCode: false }) },
    { ...successApi, fetchUser: async () => { throw new Error('network failure'); } },
  ]) {
    await assert.rejects(reconnectOfflineServer(api, new AbortController().signal));
    assert.equal(useServerStore.getState().offlineMode, true);
    assert.equal(useServerStore.getState().serverUrl, SERVER);
    assert.equal(useServerStore.getState().token, 'fictional-token');
    assert.strictEqual(useServerStore.getState().user, USER);
  }
});

test('原生接口忽略 abort 时也超时，迟到成功不能退出离线模式', async () => {
  let finish;
  const promise = reconnectOfflineServer({ ...successApi, fetchUser: () => new Promise((resolve) => { finish = resolve; }) }, new AbortController().signal, 10);
  await assert.rejects(promise, /连接超时/);
  finish({ err: 'ok', isLogin: true, user: USER });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useServerStore.getState().offlineMode, true);
  assert.equal(useServerStore.getState().isConnected, false);
});

test('离开页面或切换服务器时，旧恢复结果不能覆盖新的状态', async () => {
  for (const cancel of [
    (controller) => controller.abort(),
    () => connectSavedServerFixture(useServerStore, 'https://other.books.test'),
  ]) {
    offlineState();
    let finish;
    const controller = new AbortController();
    const promise = reconnectOfflineServer({ ...successApi, checkAccess: () => new Promise((resolve) => { finish = resolve; }) }, controller.signal);
    await cancel(controller);
    finish({ err: 'ok', needsAccessCode: false });
    assert.deepEqual(await promise, { cancelled: true });
    assert.equal(useServerStore.getState().serverUrl, controller.signal.aborted ? SERVER : 'https://other.books.test');
  }
});

test('离线切换不清除当前配置，且切换会使旧会话请求过期', async () => {
  useServerStore.setState({ offlineMode: false, isConnected: true });
  await useServerStore.getState().enterOfflineMode();
  assert.equal(useServerStore.getState().sessionRevision, 2);
  assert.equal(useServerStore.getState().serverUrl, SERVER);
  assert.equal(useServerStore.getState().token, 'fictional-token');
});

test('备用镜像不能恢复未知连接或覆盖当前运行时服务器', async () => {
  const values = new Map([['moke_server_url', 'https://fallback.books.test']]);
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key),
  } };
  try {
    await useServerStore.getState().enterOfflineMode();
    assert.equal(useServerStore.getState().serverUrl, SERVER);
    useServerStore.setState({serverUrl:'',activeServerId:null,user:null,token:''});
    await useServerStore.getState().enterOfflineMode();
    assert.equal(useServerStore.getState().serverUrl, '');
    useServerStore.getState().disconnect();
    assert.equal(values.has('moke_server_url'), false);
  } finally { delete globalThis.window; }
});

test('取消等待Reader进度的恢复不能在稍后退出离线或清除凭据', async () => {
  let entered, release;
  const started=new Promise(resolve => {entered=resolve;});
  const gate=new Promise(resolve => {release=resolve;});
  const remove=registerReaderProgressFlush(async () => {entered(); await gate;});
  const controller=new AbortController();
  const restoring=reconnectOfflineServer(successApi,controller.signal);
  try {
    await started;controller.abort();release();
    assert.deepEqual(await restoring,{cancelled:true});
    assert.equal(useServerStore.getState().offlineMode,true);
    assert.strictEqual(useServerStore.getState().user,USER);
    assert.equal(useServerStore.getState().token,'fictional-token');
  } finally {remove();release();await restoring;}
});
