import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installConsoleCapture,
  uninstallConsoleCapture,
  useDebugLogStore,
} from '../src/lib/debug-log.ts';

function mockWindow() {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
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

  uninstallConsoleCapture();
  // 卸载后 console 恢复原生行为，不再写入调试面板
  console.error('post uninstall');
  logs = useDebugLogStore.getState().logs;
  assert.equal(logs.length, 1);

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
