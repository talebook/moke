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

const authBase = process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';
const imageData = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDQiPjx0ZXh0IHg9IjEwIiB5PSIzMCI+MTIzNDwvdGV4dD48L3N2Zz4=';

async function installAuthChallenge(page, { provider = 'image', holdVerification = false } = {}) {
  const requests = [];
  const errors = [];
  const failures = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let images = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => failures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(() => {
    // The provider frame intentionally has no storage access. Seed only the
    // trusted app document, preserving the opaque-origin sandbox boundary.
    if (window !== window.top) return;
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke_server_url', 'http://library.test');
    localStorage.setItem('moke-server-storage', JSON.stringify({ state: {
      serverUrl: 'http://library.test', serverTitle: 'Test library', offlineMode: false,
      isConnected: true, user: null, hasHydrated: true,
    }, version: 0 }));
  });
  await page.route('http://library.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = new URLSearchParams(request.postData() || '');
    const headers = { 'access-control-allow-origin': authBase, 'access-control-allow-credentials': 'true' };
    let json = { err: 'ok' };
    if (path === '/api/captcha/config') {
      json = { err: 'ok', config: provider === 'image' ? { provider } : {
        provider: 'webcode', html: '<button onclick="window.__moke_captcha_success({provider:\'webcode\',answer:\'wrong\'})">提交第三方验证码</button>',
      } };
    } else if (path === '/api/captcha/image') {
      images += 1;
      json = { err: 'ok', image: imageData };
    } else if (request.method() === 'POST') {
      requests.push({ path, body: Object.fromEntries(body) });
      if (holdVerification && (body.has('captcha_code') || body.has('answer'))) await held;
      json = body.has('captcha_code') || body.has('answer')
        ? { err: 'captcha.invalid', msg: '验证码错误，请重新输入' }
        : { err: 'captcha.required', msg: '请输入人机验证码' };
    }
    await route.fulfill({ headers, json });
  });
  return { requests, errors, failures, release, imageCount: () => images };
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`authentication challenge ${viewport.width}`, () => {
    test.use({ viewport });

    test('access captcha can be corrected and refreshed without reopening', async ({ page }, testInfo) => {
      const probe = await installAuthChallenge(page);
      await page.goto(`${authBase}/access`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('请输入访问码').fill('test-access');
      const trigger = page.getByRole('button', { name: '确认', exact: true });
      await trigger.click();
      const input = page.getByPlaceholder('请输入图片中的字符');
      await expect(input).toBeVisible();
      await input.fill('wrong');
      await input.press('Enter');
      await expect.poll(() => probe.requests.length).toBe(2);
      await expect(input).toBeEnabled();
      await input.fill('corrected');
      await input.press('Enter');
      await expect.poll(() => probe.requests.length).toBe(3);
      expect(probe.requests[2].body).toEqual({ invite_code: 'test-access', captcha_code: 'corrected' });
      const dialog = page.getByRole('dialog', { name: '安全验证' });
      await expect(dialog.getByText('验证码错误，请重新输入')).toBeVisible();
      await expect(input).toBeFocused();
      const before = probe.imageCount();
      await dialog.getByTitle('刷新验证码').click();
      await expect.poll(() => probe.imageCount()).toBe(before + 1);
      await expect(input).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('access-correction.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(probe.errors).toEqual([]);
      expect(probe.failures).toEqual([]);
    });

    test('login challenge contains keyboard focus and exposes rejection', async ({ page }, testInfo) => {
      const probe = await installAuthChallenge(page);
      await page.goto(`${authBase}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('请输入用户名').fill('test-reader');
      await page.getByPlaceholder('请输入密码').fill('test-password');
      const trigger = page.getByRole('button', { name: '登录', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '安全验证' });
      const input = dialog.getByPlaceholder('请输入图片中的字符');
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await input.fill('wrong');
      await input.press('Enter');
      await expect(dialog.getByText('验证码错误，请重新输入')).toBeVisible();
      await expect(input).toBeFocused();
      await dialog.getByRole('button', { name: '确认', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeFocused();
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: testInfo.outputPath('login-focus.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(probe.errors).toEqual([]);
      expect(probe.failures).toEqual([]);
    });

    test('pending image verification sends once and cannot close or refresh', async ({ page }) => {
      const probe = await installAuthChallenge(page, { holdVerification: true });
      await page.goto(`${authBase}/access`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('请输入访问码').fill('test-access');
      await page.getByRole('button', { name: '确认', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '安全验证' });
      const input = dialog.getByPlaceholder('请输入图片中的字符');
      await input.fill('wrong');
      await input.evaluate((element) => {
        element.form.requestSubmit();
        element.form.requestSubmit();
      });
      await expect.poll(() => probe.requests.length).toBe(2);
      await expect(input).toBeDisabled();
      await expect(dialog.getByTitle('刷新验证码')).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      probe.release();
      await expect(input).toBeEnabled();
      await expect(input).toBeFocused();
      expect(probe.requests).toHaveLength(2);
      expect(probe.errors).toEqual([]);
      expect(probe.failures).toEqual([]);
    });

    test('third party sandbox can retry a rejected challenge', async ({ page }) => {
      const probe = await installAuthChallenge(page, { provider: 'webcode' });
      await page.goto(`${authBase}/access`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('请输入访问码').fill('test-access');
      await page.getByRole('button', { name: '确认', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '安全验证' });
      const submit = dialog.frameLocator('iframe').getByRole('button', { name: '提交第三方验证码' });
      await submit.click();
      await expect(dialog.getByText('验证码错误，请重新输入')).toBeVisible();
      await submit.click();
      await expect.poll(() => probe.requests.length).toBe(3);
      expect(probe.requests[2].body).toEqual({ invite_code: 'test-access', provider: 'webcode', answer: 'wrong' });
      // Focus is inside the opaque frame; use the host's close control after
      // the verification promise settles rather than racing its pending guard.
      await dialog.getByRole('button', { name: '关闭安全验证' }).click();
      await expect(dialog).toBeHidden();
      expect(probe.errors).toEqual([]);
      expect(probe.failures).toEqual([]);
    });
  });
}
