import { test, expect } from '@playwright/test';

import {
  buildCaptchaSandboxDocument,
  buildGeetestSandboxDocument,
  DEFAULT_GEETEST_SDK_URL,
} from '../src/lib/captcha-core.ts';

test('malicious web code executes only inside the opaque captcha frame', async ({ page }) => {
  const channel = 'playwright-captcha-channel';
  const sandboxDocument = buildCaptchaSandboxDocument(`<script>
    document.title = 'sandbox-controlled';

    let parentAccessBlocked = false;
    try {
      window.parent.document.title = 'attacker-controlled';
    } catch {
      parentAccessBlocked = true;
    }

    let directTauriInvokeRejected = false;
    try {
      window.__TAURI_INTERNALS__.invoke('moke_list_downloaded_books');
    } catch {
      directTauriInvokeRejected = true;
    }

    let parentTauriAccessBlocked = false;
    try {
      window.parent.__TAURI_INTERNALS__.invoke('moke_list_downloaded_books');
    } catch {
      parentTauriAccessBlocked = true;
    }

    window.__moke_captcha_success({
      frameTitle: document.title,
      parentAccessBlocked,
      directTauriInvokeRejected,
      parentTauriAccessBlocked,
    });
  </script>`, channel);

  await page.setContent(`<!doctype html>
    <title>moke-safe</title>
    <iframe id="captcha" title="captcha" sandbox="allow-scripts"></iframe>`);

  const result = await page.evaluate(({ srcdoc, expectedChannel }) => new Promise((resolve, reject) => {
    const frame = document.getElementById('captcha');
    window.__parentInvokeCalled = false;
    window.__TAURI_INTERNALS__ = {
      invoke: () => {
        window.__parentInvokeCalled = true;
      },
    };

    const timeout = window.setTimeout(() => reject(new Error('captcha message timeout')), 5_000);
    const handleMessage = (event) => {
      if (
        event.source !== frame.contentWindow
        || event.origin !== 'null'
        || event.data?.kind !== 'moke-captcha-sandbox-v1'
        || event.data?.channel !== expectedChannel
      ) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
      resolve({
        payload: event.data.payload,
        origin: event.origin,
        parentTitle: document.title,
        parentInvokeCalled: window.__parentInvokeCalled,
        sandbox: frame.getAttribute('sandbox'),
      });
    };
    window.addEventListener('message', handleMessage);

    frame.srcdoc = srcdoc;
  }), { srcdoc: sandboxDocument, expectedChannel: channel });

  expect(result).toEqual({
    payload: {
      frameTitle: 'sandbox-controlled',
      parentAccessBlocked: true,
      directTauriInvokeRejected: true,
      parentTauriAccessBlocked: true,
    },
    origin: 'null',
    parentTitle: 'moke-safe',
    parentInvokeCalled: false,
    sandbox: 'allow-scripts',
  });
});

test('GeeTest SDK completes through the same sandbox message bridge', async ({ page }) => {
  await page.route(DEFAULT_GEETEST_SDK_URL, (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      window.initGeetest4 = (options, ready) => {
        let success;
        const captcha = {
          appendTo: () => captcha,
          onSuccess: (callback) => { success = callback; return captcha; },
          onError: () => captcha,
          showCaptcha: () => success(),
          getValidate: () => ({
            lot_number: options.https && options.protocol === 'https://' ? 'lot-number' : 'wrong-protocol',
            captcha_output: 'captcha-output',
            pass_token: 'pass-token',
            gen_time: 'gen-time',
          }),
        };
        ready(captcha);
      };
    `,
  }));

  const channel = 'playwright-geetest-channel';
  const sandboxDocument = buildGeetestSandboxDocument({ captchaId: 'captcha-id' }, channel);
  await page.setContent('<iframe id="captcha" title="captcha" sandbox="allow-scripts"></iframe>');

  const message = await page.evaluate(({ srcdoc, expectedChannel }) => new Promise((resolve, reject) => {
    const frame = document.getElementById('captcha');
    const timeout = window.setTimeout(() => reject(new Error('GeeTest message timeout')), 5_000);
    const handleMessage = (event) => {
      if (
        event.source !== frame.contentWindow
        || event.origin !== 'null'
        || event.data?.channel !== expectedChannel
      ) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
      resolve({ origin: event.origin, data: event.data });
    };
    window.addEventListener('message', handleMessage);
    frame.srcdoc = srcdoc;
  }), { srcdoc: sandboxDocument, expectedChannel: channel });

  expect(message).toEqual({
    origin: 'null',
    data: {
      kind: 'moke-captcha-sandbox-v1',
      channel,
      type: 'success',
      payload: {
        provider: 'geetest',
        lot_number: 'lot-number',
        captcha_output: 'captcha-output',
        pass_token: 'pass-token',
        gen_time: 'gen-time',
      },
    },
  });
});
