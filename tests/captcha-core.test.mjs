import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGeetestOptions } from '../src/lib/captcha-core.ts';

test('GeeTest forces HTTPS only in the OHOS custom-scheme WebView', () => {
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
