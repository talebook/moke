import test from 'node:test';
import assert from 'node:assert/strict';
import { throwIfAborted } from '../src/lib/abort-signal.ts';
import { checkSavedServer } from '../src/lib/server-connection.ts';

test('a legacy signal without throwIfAborted or reason can continue and report cancellation', () => {
  assert.doesNotThrow(() => throwIfAborted({ aborted: false }));
  assert.doesNotThrow(() => throwIfAborted());
  assert.throws(() => throwIfAborted({ aborted: true }), { name: 'AbortError' });
  const reason = new Error('specific reason');
  assert.throws(() => throwIfAborted({ aborted: true, reason }), error => error === reason);
});

test('server validation works without the native cancellation convenience API', async () => {
  const abort = new AbortController();
  Object.defineProperty(abort.signal, 'throwIfAborted', { value: undefined });
  const calls = [];
  const checks = {
    validate: async () => { calls.push('validate'); return { err: 'ok' }; },
    welcome: async () => { calls.push('welcome'); return { err: 'ok', needsAccessCode: false }; },
  };
  assert.deepEqual(await checkSavedServer('https://books.test', checks, abort.signal), { err: 'ok', needsAccessCode: false });
  assert.deepEqual(calls, ['validate', 'welcome']);
  abort.abort();
  await assert.rejects(checkSavedServer('https://books.test', checks, abort.signal), { name: 'AbortError' });
  assert.deepEqual(calls, ['validate', 'welcome']);
});
