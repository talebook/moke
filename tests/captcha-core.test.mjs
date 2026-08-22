import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCaptchaSandboxDocument,
  buildGeetestOptions,
  buildGeetestSandboxDocument,
  CAPTCHA_SANDBOX_ORIGIN,
  createImageCaptchaRequestLifecycle,
  DEFAULT_GEETEST_SDK_URL,
  parseCaptchaSandboxMessage,
  resolveGeetestSdkUrl,
} from '../src/lib/captcha-core.ts';

const captchaModalSource = readFileSync(
  fileURLToPath(new URL('../src/components/auth/CaptchaModal.tsx', import.meta.url)),
  'utf8',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createImageCaptchaState() {
  const state = { image: '', error: '', loading: false };
  const callbacks = {
    onImage: (image) => { state.image = image; },
    onError: (error) => { state.error = error; },
    onLoadingChange: (loading) => { state.loading = loading; },
  };
  return { state, callbacks };
}

test('closing during an image request aborts it and ignores a late success', async () => {
  const lifecycle = createImageCaptchaRequestLifecycle();
  const pending = deferred();
  const { state, callbacks } = createImageCaptchaState();
  let signal;

  const loading = lifecycle.load((requestSignal) => {
    signal = requestSignal;
    return pending.promise;
  }, callbacks);

  assert.equal(state.loading, true);
  lifecycle.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(state.loading, false);

  pending.resolve({ err: 'ok', image: 'stale-image' });
  await loading;
  assert.deepEqual(state, { image: '', error: '', loading: false });
});

test('switching from image to webcode or GeeTest ignores a late failed response', async () => {
  for (const nextMode of ['webcode', 'geetest']) {
    const lifecycle = createImageCaptchaRequestLifecycle();
    const pending = deferred();
    const { state, callbacks } = createImageCaptchaState();
    const loading = lifecycle.load(() => pending.promise, callbacks);

    lifecycle.cancel();
    pending.resolve({ err: 'captcha.failed', msg: `stale-${nextMode}-error` });
    await loading;

    assert.deepEqual(
      state,
      { image: '', error: '', loading: false },
      `late image response must not affect ${nextMode} mode`,
    );
  }
});

test('reopening starts a new image request that cannot be overwritten by the old success', async () => {
  const lifecycle = createImageCaptchaRequestLifecycle();
  const oldPending = deferred();
  const newPending = deferred();
  const { state, callbacks } = createImageCaptchaState();

  const oldLoading = lifecycle.load(() => oldPending.promise, callbacks);
  lifecycle.cancel();
  const newLoading = lifecycle.load(() => newPending.promise, callbacks);

  oldPending.resolve({ err: 'ok', image: 'old-image' });
  await oldLoading;
  assert.deepEqual(state, { image: '', error: '', loading: true });

  newPending.resolve({ err: 'ok', image: 'new-image' });
  await newLoading;
  assert.deepEqual(state, { image: 'new-image', error: '', loading: false });
});

test('a rejected old image request cannot replace state after reopening', async () => {
  const lifecycle = createImageCaptchaRequestLifecycle();
  const oldPending = deferred();
  const newPending = deferred();
  const { state, callbacks } = createImageCaptchaState();

  const oldLoading = lifecycle.load(() => oldPending.promise, callbacks);
  lifecycle.cancel();
  const newLoading = lifecycle.load(() => newPending.promise, callbacks);
  newPending.resolve({ err: 'ok', image: 'new-image' });
  await newLoading;

  oldPending.reject(new Error('late network failure'));
  await oldLoading;
  assert.deepEqual(state, { image: 'new-image', error: '', loading: false });
});

test('the current image request still reports server and network failures', async () => {
  const lifecycle = createImageCaptchaRequestLifecycle();
  const serverFailure = createImageCaptchaState();
  await lifecycle.load(
    async () => ({ err: 'captcha.failed', msg: 'current server failure' }),
    serverFailure.callbacks,
  );
  assert.deepEqual(
    serverFailure.state,
    { image: '', error: 'current server failure', loading: false },
  );

  const networkFailure = createImageCaptchaState();
  await lifecycle.load(
    async () => { throw new Error('current network failure'); },
    networkFailure.callbacks,
  );
  assert.deepEqual(
    networkFailure.state,
    { image: '', error: '网络错误，无法加载验证码', loading: false },
  );
});

test('GeeTest forces HTTPS only when requested by its WebView context', () => {
  assert.deepEqual(buildGeetestOptions({ captchaId: 'captcha-id' }, true), {
    captchaId: 'captcha-id',
    product: 'popup',
    language: 'zho',
    https: true,
    protocol: 'https://',
  });

  assert.deepEqual(buildGeetestOptions({ captchaId: 'captcha-id' }, false), {
    captchaId: 'captcha-id',
    product: 'popup',
    language: 'zho',
  });
});

test('GeeTest SDK URL accepts only the explicit HTTPS host allowlist', () => {
  assert.equal(resolveGeetestSdkUrl(undefined), DEFAULT_GEETEST_SDK_URL);
  assert.equal(resolveGeetestSdkUrl(''), DEFAULT_GEETEST_SDK_URL);
  assert.equal(
    resolveGeetestSdkUrl('https://static.geetest.com/v4/gt4.js?version=4'),
    'https://static.geetest.com/v4/gt4.js?version=4',
  );

  for (const url of [
    'http://static.geetest.com/v4/gt4.js',
    '//static.geetest.com/v4/gt4.js',
    'javascript:alert(1)',
    'data:text/javascript,alert(1)',
    'https://static.geetest.com.evil.example/v4/gt4.js',
    'https://evil.example/?next=static.geetest.com',
    'https://user@static.geetest.com/v4/gt4.js',
  ]) {
    assert.throws(() => resolveGeetestSdkUrl(url), /不受信任/, url);
  }
});

test('remote web code is wrapped after a callback bridge in an opaque sandbox document', () => {
  const channel = 'captcha-channel';
  const maliciousHtml = `<script>
    document.title = 'attacker-controlled';
    window.parent.document.title = 'parent-controlled';
    window.__TAURI_INTERNALS__.invoke('moke_list_downloaded_books');
  </script>`;
  const document = buildCaptchaSandboxDocument(maliciousHtml, channel);

  assert.match(document, /window\.__moke_captcha_success/);
  assert.match(document, /window\.parent\.postMessage/);
  assert.ok(document.indexOf('window.__moke_captcha_success') < document.indexOf(maliciousHtml));
  assert.match(document, /document\.title = 'attacker-controlled'/);

  const escaped = buildCaptchaSandboxDocument('', `</script><script>parent.pwned = true</script>`);
  assert.doesNotMatch(escaped, /<script>parent\.pwned/);
  assert.match(escaped, /\\u003c\/script\\u003e/);
});

test('GeeTest is initialized inside the sandbox and rejects an untrusted SDK before rendering', () => {
  const document = buildGeetestSandboxDocument(
    { captchaId: 'captcha-id', sdkUrl: DEFAULT_GEETEST_SDK_URL },
    'captcha-channel',
  );

  assert.match(document, /https:\/\/static\.geetest\.com\/v4\/gt4\.js/);
  assert.match(document, /"https":true/);
  assert.match(document, /window\.__moke_captcha_success/);
  assert.match(document, /id="geetest-container"/);
  assert.throws(
    () => buildGeetestSandboxDocument(
      { captchaId: 'captcha-id', sdkUrl: 'https://attacker.example/captcha.js' },
      'captcha-channel',
    ),
    /不受信任/,
  );
});

test('captcha messages require opaque origin, exact frame source, channel, and message type', () => {
  const frameWindow = {};
  const validEvent = {
    origin: CAPTCHA_SANDBOX_ORIGIN,
    source: frameWindow,
    data: {
      kind: 'moke-captcha-sandbox-v1',
      channel: 'captcha-channel',
      type: 'success',
      payload: { token: 'verified' },
    },
  };

  assert.deepEqual(
    parseCaptchaSandboxMessage(validEvent, frameWindow, 'captcha-channel'),
    { type: 'success', payload: { token: 'verified' } },
  );
  assert.equal(
    parseCaptchaSandboxMessage({ ...validEvent, origin: 'https://server.example' }, frameWindow, 'captcha-channel'),
    null,
  );
  assert.equal(parseCaptchaSandboxMessage(validEvent, {}, 'captcha-channel'), null);
  assert.equal(parseCaptchaSandboxMessage(validEvent, frameWindow, 'stale-channel'), null);
  assert.equal(
    parseCaptchaSandboxMessage(
      { ...validEvent, data: { ...validEvent.data, type: 'invoke' } },
      frameWindow,
      'captcha-channel',
    ),
    null,
  );
});

test('CaptchaModal cancels image requests on close and provider lifecycle cleanup', () => {
  assert.match(captchaModalSource, /signal,/);
  assert.match(captchaModalSource, /return cancelImageCaptcha;/);
  assert.match(captchaModalSource, /if \(!isOpen\) \{\s*cancelImageCaptcha\(\);/);
  assert.match(
    captchaModalSource,
    /\[cancelImageCaptcha, config, fetchImageCaptcha, isOpen, mode, serverUrl\]/,
  );
});

test('CaptchaModal never injects server HTML or GeeTest SDK into the privileged parent document', () => {
  assert.match(captchaModalSource, /<iframe/);
  assert.match(captchaModalSource, /sandbox="allow-scripts"/);
  assert.doesNotMatch(captchaModalSource, /allow-same-origin/);
  assert.doesNotMatch(captchaModalSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(captchaModalSource, /document\.createElement\(['"]script['"]\)/);
  assert.doesNotMatch(captchaModalSource, /\(window as any\)\.__moke_captcha/);
});
