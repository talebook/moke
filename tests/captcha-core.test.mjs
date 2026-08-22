import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCaptchaSandboxDocument,
  buildGeetestOptions,
  buildGeetestSandboxDocument,
  CAPTCHA_SANDBOX_ORIGIN,
  DEFAULT_GEETEST_SDK_URL,
  parseCaptchaSandboxMessage,
  resolveGeetestSdkUrl,
} from '../src/lib/captcha-core.ts';

const captchaModalSource = readFileSync(
  fileURLToPath(new URL('../src/components/auth/CaptchaModal.tsx', import.meta.url)),
  'utf8',
);

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

test('CaptchaModal never injects server HTML or GeeTest SDK into the privileged parent document', () => {
  assert.match(captchaModalSource, /<iframe/);
  assert.match(captchaModalSource, /sandbox="allow-scripts"/);
  assert.doesNotMatch(captchaModalSource, /allow-same-origin/);
  assert.doesNotMatch(captchaModalSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(captchaModalSource, /document\.createElement\(['"]script['"]\)/);
  assert.doesNotMatch(captchaModalSource, /\(window as any\)\.__moke_captcha/);
});
