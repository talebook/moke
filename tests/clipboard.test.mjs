import test from 'node:test';
import assert from 'node:assert/strict';

import { copyTextToClipboard } from '../src/lib/clipboard.ts';

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function makeDocument(execResult) {
  const textarea = { value: '', style: {}, focus() {}, select() {} };
  return {
    createElement: () => textarea,
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => execResult,
  };
}

test('优先使用 navigator.clipboard.writeText', async () => {
  const calls = [];
  const writeText = async (t) => { calls.push(t); };
  setNavigator({ clipboard: { writeText } });
  globalThis.document = undefined;

  const ok = await copyTextToClipboard('hello');

  assert.equal(ok, true);
  assert.deepEqual(calls, ['hello']);
});

test('navigator.clipboard 失败时回退到 execCommand', async () => {
  setNavigator({
    clipboard: { writeText: async () => { throw new Error('denied'); } },
  });
  globalThis.document = makeDocument(true);

  const ok = await copyTextToClipboard('hello');

  assert.equal(ok, true);
});

test('execCommand 返回 false 时整体返回 false', async () => {
  setNavigator({
    clipboard: { writeText: async () => { throw new Error('denied'); } },
  });
  globalThis.document = makeDocument(false);

  const ok = await copyTextToClipboard('hello');

  assert.equal(ok, false);
});

test('无 navigator 与 document（SSR）时安全返回 false', async () => {
  setNavigator(undefined);
  globalThis.document = undefined;

  const ok = await copyTextToClipboard('hello');

  assert.equal(ok, false);
});
