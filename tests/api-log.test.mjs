import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MokeApiError } from '../src/lib/api-core.ts';
import {
  getSafeErrorCode,
  logErrorMetadata,
  logHttpErrorMetadata,
} from '../src/lib/api-log.ts';

const welcomeSource = readFileSync(
  fileURLToPath(new URL('../src/app/welcome/page.tsx', import.meta.url)),
  'utf8',
);

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

test('畸形 err 会继续回退到合法 code，且不读取原型链字段', () => {
  for (const err of [undefined, 500, 'token=secret-token']) {
    assert.equal(getSafeErrorCode({ err, code: 'http.500' }), 'http.500');
  }

  const inheritedErr = Object.assign(
    Object.create({ err: 'user.need_login' }),
    { code: 'server.invalid_response' },
  );
  assert.equal(getSafeErrorCode(inheritedErr), 'server.invalid_response');
});

test('token 形状或未列入白名单的值不会被当作错误码', () => {
  for (const token of [
    'secret-token',
    'abc_def.ghi-jkl',
    'eyJhbGciOiJIUzI1NiJ9.abc_def.signature',
    'server.secret_token',
  ]) {
    assert.equal(getSafeErrorCode({ err: token }), 'unknown');
  }
  assert.equal(getSafeErrorCode({ msg: 'private response body' }), 'unknown');
});

test('MokeApiError 真实错误对象只输出自身 code 和 HTTP 状态', () => {
  const error = new MokeApiError(
    'gateway body contains token=secret-token',
    'server.invalid_response',
    502,
  );
  const calls = [];

  logHttpErrorMetadata(
    'checkWelcomeRequirement invalid response',
    error.status,
    error,
    (...args) => calls.push(args),
  );

  assert.equal(getSafeErrorCode(error), 'server.invalid_response');
  assert.deepEqual(calls, [[
    '[checkWelcomeRequirement invalid response] HTTP status=%d err=%s',
    502,
    'server.invalid_response',
  ]]);
  assert.equal(JSON.stringify(calls).includes('secret-token'), false);
});

test('welcome 两条失败分支只记录元数据，同时保留服务端文案给用户', () => {
  assert.match(
    welcomeSource,
    /logErrorMetadata\('WelcomePage validateServerConnection failed', result\)/,
  );
  assert.match(
    welcomeSource,
    /logErrorMetadata\('WelcomePage checkWelcomeRequirement failed', welcome\)/,
  );
  assert.doesNotMatch(
    welcomeSource,
    /console\.error\('\[WelcomePage\] (?:validateServerConnection|checkWelcomeRequirement) failed:',/,
  );
  assert.match(welcomeSource, /setError\(result\.msg \|\| '服务器校验失败'\)/);
  assert.match(welcomeSource, /setError\(welcome\.msg \|\| '访问码状态检查失败'\)/);

  const calls = [];
  logErrorMetadata(
    'WelcomePage validateServerConnection failed',
    { err: 'http.503', msg: 'validate raw msg token=first-secret' },
    (...args) => calls.push(args),
  );
  logErrorMetadata(
    'WelcomePage checkWelcomeRequirement failed',
    { err: 'server.invalid_response', msg: 'welcome raw msg token=second-secret' },
    (...args) => calls.push(args),
  );

  assert.deepEqual(calls, [
    ['[WelcomePage validateServerConnection failed] err=%s', 'http.503'],
    ['[WelcomePage checkWelcomeRequirement failed] err=%s', 'server.invalid_response'],
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /first-secret|second-secret/);
});
