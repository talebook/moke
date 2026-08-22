import test from 'node:test';
import assert from 'node:assert/strict';

import { logErrorMetadata } from '../src/lib/api-log.ts';
import {
  installConsoleCapture,
  uninstallConsoleCapture,
  useDebugLogStore,
} from '../src/lib/debug-log.ts';

function mockWindow() {
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
  return localStorage;
}
function restoreWindow() {
  delete globalThis.window;
}

test('installConsoleCapture patch console 后日志进入面板，uninstall 后不再捕获', () => {
  mockWindow();
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  useDebugLogStore.getState().clear();
  installConsoleCapture();

  // console 已被 patch（引用变化）
  assert.notEqual(console.log, originals.log);
  assert.notEqual(console.warn, originals.warn);

  console.warn('capture me');
  let logs = useDebugLogStore.getState().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].message, 'capture me');
  assert.equal(logs[0].type, 'console');
  assert.equal(logs[0].source, 'moke');

  uninstallConsoleCapture();
  // 卸载后 console 恢复原生行为，不再写入调试面板
  console.error('post uninstall');
  logs = useDebugLogStore.getState().logs;
  assert.equal(logs.length, 1);

  restoreWindow();
});

test('welcome 失败元数据持久化时不包含两条调用链的原始 msg', () => {
  const localStorage = mockWindow();
  let serialized = '';

  try {
    useDebugLogStore.getState().clear();
    installConsoleCapture();
    logErrorMetadata('WelcomePage validateServerConnection failed', {
      err: 'user.need_login',
      msg: 'validate raw msg token=first-secret',
    });
    logErrorMetadata('WelcomePage checkWelcomeRequirement failed', {
      err: 'server.invalid_response',
      msg: 'welcome raw msg token=second-secret',
    });
    serialized = localStorage.getItem('moke-debug-logs-v1') || '';
  } finally {
    uninstallConsoleCapture();
    restoreWindow();
  }

  const stored = JSON.parse(serialized);
  assert.equal(stored.length, 2);
  assert.match(serialized, /user\.need_login/);
  assert.match(serialized, /server\.invalid_response/);
  assert.doesNotMatch(serialized, /validate raw msg|welcome raw msg|first-secret|second-secret/);
});

test('日志持久化，显式清空后不会被旧快照带回', () => {
  const localStorage = mockWindow();
  useDebugLogStore.getState().clear();
  useDebugLogStore.getState().addLog('warn', 'connection', 'before disconnect');

  let stored = JSON.parse(localStorage.getItem('moke-debug-logs-v1'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message, 'before disconnect');

  useDebugLogStore.getState().clear();
  useDebugLogStore.getState().addLog('info', 'connection', 'after reconnect');

  stored = JSON.parse(localStorage.getItem('moke-debug-logs-v1'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message, 'after reconnect');
  assert.ok(Number(localStorage.getItem('moke-debug-logs-cleared-at-v1')) > 0);
  restoreWindow();
});

test('未安装时不 patch console（重复安装/卸载幂等）', () => {
  mockWindow();

  const original = console.log;
  uninstallConsoleCapture();
  assert.equal(console.log, original);

  installConsoleCapture();
  installConsoleCapture();
  assert.notEqual(console.log, original);

  uninstallConsoleCapture();
  uninstallConsoleCapture();
  // 卸载后调用不再进入捕获（与上一条断言互补，避免依赖函数引用相等）
  useDebugLogStore.getState().clear();
  console.log('after final uninstall');
  assert.equal(useDebugLogStore.getState().logs.length, 0);

  restoreWindow();
});
