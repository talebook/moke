import test from 'node:test';
import assert from 'node:assert/strict';

import { getSafeErrorCode, logHttpErrorMetadata } from '../src/lib/api-log.ts';

test('HTTP error logging only emits status and a safe error code', () => {
  const calls = [];
  const sensitiveResponse = {
    err: 'user.need_login',
    msg: 'token=secret-token',
    password: 'secret-password',
    cookie: 'session=secret-cookie',
    user: { email: 'reader@example.com' },
  };

  for (const status of [401, 503]) {
    logHttpErrorMetadata('validateServerConnection', status, sensitiveResponse, (...args) => calls.push(args));
  }

  assert.deepEqual(calls, [401, 503].map(status => [
    '[validateServerConnection] HTTP status=%d err=%s',
    status,
    'user.need_login',
  ]));
  const serialized = JSON.stringify(calls);
  for (const secret of ['secret-token', 'secret-password', 'secret-cookie', 'reader@example.com']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('arbitrary error text is not treated as an error code', () => {
  assert.equal(getSafeErrorCode({ err: 'token=secret-token' }), 'unknown');
  assert.equal(getSafeErrorCode({ code: 'http.500' }), 'http.500');
  assert.equal(getSafeErrorCode({ msg: 'private response body' }), 'unknown');

  const calls = [];
  logHttpErrorMetadata(
    'checkWelcomeRequirement invalid response',
    502,
    { code: 'http.502', message: 'gateway body contains secret-token' },
    (...args) => calls.push(args),
  );
  assert.equal(JSON.stringify(calls).includes('secret-token'), false);
});
