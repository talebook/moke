import test from 'node:test';
import assert from 'node:assert/strict';
import { retryOnlineRead } from '../src/lib/online-retry.ts';

test('optional progress timeout aborts its request without retrying', async () => {
  let requestSignal;
  let attempts = 0;
  await assert.rejects(retryOnlineRead((signal) => {
    requestSignal = signal;
    attempts += 1;
    return new Promise(() => {});
  }, () => false, new AbortController().signal, 10), { name: 'TimeoutError' });
  assert.equal(attempts, 1);
  assert.equal(requestSignal.aborted, true);
});
