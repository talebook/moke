import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVER_CAPABILITIES_TTL_MS,
  isServerCapabilitiesFresh,
  resolveCurrentUserResult,
  resolveUserAfterSync,
} from '../src/lib/server-session.ts';
import {
  DEFAULT_SERVER_CAPABILITIES,
  useServerStore,
} from '../src/lib/store/server.ts';

function reader(id = 7) {
  return {
    id,
    username: `reader-${id}`,
    name: `读者 ${id}`,
    email: '',
    avatar: '',
    admin: false,
    permission: '',
  };
}

test('user/info 暂时失败时保留 cookie 会话对应的最后确认用户', () => {
  const currentUser = reader();
  let failure;
  assert.throws(
    () => resolveCurrentUserResult({ err: 'server.busy', msg: '稍后重试' }, false, 503),
    (error) => {
      failure = error;
      return error.code === 'server.busy' && error.status === 503;
    },
  );
  assert.strictEqual(resolveUserAfterSync(currentUser, currentUser, { status: 'rejected', reason: failure }), currentUser);
});

test('只有明确未登录响应才清空已确认用户', () => {
  const currentUser = reader();
  const guest = resolveCurrentUserResult({ err: 'ok', user: { is_login: false } }, true, 200);
  const authRequired = resolveCurrentUserResult({ err: 'user.need_login', msg: '请登录' }, false, 401);
  assert.equal(resolveUserAfterSync(currentUser, currentUser, { status: 'fulfilled', value: guest }), null);
  assert.equal(resolveUserAfterSync(currentUser, currentUser, { status: 'fulfilled', value: authRequired }), null);
});

test('非登录业务错误不会被当成确认退出', () => {
  assert.throws(
    () => resolveCurrentUserResult({ err: 'gateway.unauthorized' }, false, 401),
    (error) => error.code === 'gateway.unauthorized' && error.status === 401,
  );
});

test('在途用户同步不会覆盖之后写入的新会话', async () => {
  const userAtSyncStart = reader(1);
  const currentUser = reader(1);
  const staleGuestResult = {
    status: 'fulfilled',
    value: { user: null },
  };

  assert.strictEqual(
    resolveUserAfterSync(userAtSyncStart, currentUser, staleGuestResult),
    currentUser,
  );
});

test('能力缓存严格遵守五分钟 TTL', () => {
  const now = 1_000_000;
  assert.equal(isServerCapabilitiesFresh(null, now), false);
  assert.equal(isServerCapabilitiesFresh(now, now), true);
  assert.equal(isServerCapabilitiesFresh(now - SERVER_CAPABILITIES_TTL_MS + 1, now), true);
  assert.equal(isServerCapabilitiesFresh(now - SERVER_CAPABILITIES_TTL_MS, now), false);
});

test('游客登录后立即失效乐观标注能力并重新确认', () => {
  const checkedAt = Date.now();
  useServerStore.setState({
    serverUrl: 'http://talebook.test',
    user: null,
    capabilities: {
      ...DEFAULT_SERVER_CAPABILITIES,
      annotationApiStatus: 'supported',
      annotationApiCheckedAt: checkedAt,
      checkedAt,
    },
  });

  const revisionBeforeLogin = useServerStore.getState().sessionRevision;
  useServerStore.getState().setConnected('', reader());

  const loggedInState = useServerStore.getState();
  assert.equal(loggedInState.sessionRevision, revisionBeforeLogin + 1);
  assert.equal(loggedInState.capabilities.annotationApiStatus, 'unchecked');
  assert.equal(loggedInState.capabilities.annotationApiCheckedAt, null);
  assert.equal(loggedInState.capabilities.checkedAt, null);
  assert.equal(isServerCapabilitiesFresh(loggedInState.capabilities.checkedAt), false);

  useServerStore.getState().disconnect();
});

test('同一已确认用户不破坏缓存，换号与退出会失效能力', () => {
  const firstUser = reader(1);
  const checkedAt = Date.now();
  useServerStore.setState({
    serverUrl: 'http://talebook.test',
    user: firstUser,
    capabilities: {
      ...DEFAULT_SERVER_CAPABILITIES,
      annotationApiStatus: 'supported',
      annotationApiCheckedAt: checkedAt,
      checkedAt,
    },
  });

  const revisionBeforeSync = useServerStore.getState().sessionRevision;
  useServerStore.getState().setUser({ ...firstUser, name: '更新后的昵称' });
  assert.equal(useServerStore.getState().sessionRevision, revisionBeforeSync);
  assert.equal(useServerStore.getState().capabilities.checkedAt, checkedAt);
  assert.equal(useServerStore.getState().capabilities.annotationApiStatus, 'supported');

  useServerStore.getState().setUser(reader(2));
  assert.equal(useServerStore.getState().sessionRevision, revisionBeforeSync + 1);
  assert.equal(useServerStore.getState().capabilities.checkedAt, null);
  assert.equal(useServerStore.getState().capabilities.annotationApiStatus, 'unchecked');
  assert.equal(useServerStore.getState().capabilities.annotationApiCheckedAt, null);

  useServerStore.setState({
    capabilities: {
      ...DEFAULT_SERVER_CAPABILITIES,
      annotationApiStatus: 'supported',
      annotationApiCheckedAt: checkedAt,
      checkedAt,
    },
  });
  useServerStore.getState().logout();
  assert.equal(useServerStore.getState().sessionRevision, revisionBeforeSync + 2);
  assert.equal(useServerStore.getState().capabilities.checkedAt, null);
  assert.equal(useServerStore.getState().capabilities.annotationApiStatus, 'unchecked');
  assert.equal(useServerStore.getState().capabilities.annotationApiCheckedAt, null);

  useServerStore.getState().disconnect();
});
