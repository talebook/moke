import { test, expect } from '@playwright/test';
import { deferred, fillAuthPage, installCaptchaFixture, openAuthChallenge } from './helpers/captcha-fixture.mjs';

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

for (const provider of ['webcode', 'geetest']) {
  test(`${provider}: closing revokes queued results before the frame is removed`, async ({ page }, info) => {
    const probe = await installCaptchaFixture(page, { provider });
    const dialog = await openAuthChallenge(page, 'access');
    const solve = dialog.frameLocator('iframe').getByRole('button');
    await expect(solve).toBeVisible(); await solve.focus();
    const channel = await dialog.locator('iframe').evaluate((frame) => JSON.parse(/const channel = ("[^"]+")/.exec(frame.srcdoc)[1]));
    await solve.evaluate((_, current) => {
      parent.postMessage({ kind: 'moke-captcha-sandbox-v1', channel: current, type: 'dismiss', payload: null }, '*');
      parent.postMessage({ kind: 'moke-captcha-sandbox-v1', channel: current, type: 'success', payload: { answer: 'correct' } }, '*');
    }, channel);
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(dialog.frameLocator('iframe').getByRole('button')).toBeVisible();
    expect(probe.posts).toHaveLength(2);
    await attachProbe(info, page, probe);
    expect(probe.errors).toEqual([]); expect(probe.failures).toEqual([]);
  });
}

async function enterAuthFromPreviousPage(page, path, probe) {
  const previous = `${authBase}/${path === 'access' ? 'login' : 'library'}`;
  await page.goto(previous);
  if (path === 'login') {
    // Let the previous library's own capability probe finish before taking a
    // session snapshot. Its normal completion is unrelated to this login.
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.capabilities?.checkedAt)).toBeTruthy();
    await page.getByRole('link', { name: '登录', exact: true }).click();
  }
  else {
    probe.plans.push({ json: { err: 'user.private.not_valid' } });
    await (await fillAuthPage(page, 'login')).click();
    await expect(page).toHaveURL(`${authBase}/access`);
  }
  await (await fillAuthPage(page, path)).click();
  await expect(page.getByPlaceholder('请输入图片中的字符')).toBeVisible();
  return previous;
}

async function releasePost(page, gate) {
  const response = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().startsWith('http://library.test/'));
  gate.resolve();
  await (await response).finished();
}

async function attachProbe(info, page, probe) {
  await info.attach('lifecycle-observations.json', { body: JSON.stringify({
    url: page.url(), posts: probe.posts, errors: probe.errors, failures: probe.failures, console: probe.console,
  }, null, 2), contentType: 'application/json' });
}

for (const path of ['access', 'login']) {
  for (const result of ['ok', 'captcha.invalid', 'transport']) {
    test(`${path}: real Back ignores late ${result} without changing the current session`, async ({ page }, info) => {
      const probe = await installCaptchaFixture(page);
      const previous = await enterAuthFromPreviousPage(page, path, probe);
      const gate = deferred();
      probe.plans.push({ gate, abort: result === 'transport', json: { err: result, msg: 'Stale verification result' } });
      const before = probe.posts.length;
      await page.getByPlaceholder('请输入图片中的字符').fill('correct');
      await page.getByPlaceholder('请输入图片中的字符').press('Enter');
      await expect.poll(() => probe.posts.length).toBe(before + 1);
      await page.goBack();
      await expect(page).toHaveURL(previous);
      const session = await page.evaluate(() => localStorage.getItem('moke-server-storage'));
      if (result === 'transport') {
        const failed = page.waitForEvent('requestfailed', (request) => request.method() === 'POST' && request.url().startsWith('http://library.test/'));
        gate.resolve(); await failed;
      } else await releasePost(page, gate);
      const navigated = await page.waitForURL(`${authBase}/shelf`, { timeout: 1000 }).then(() => true, () => false);
      expect(navigated).toBe(false);
      await expect(page).toHaveURL(previous);
      expect(await page.evaluate(() => localStorage.getItem('moke-server-storage'))).toBe(session);
      await expect(page.getByRole('dialog', { name: '安全验证' })).toBeHidden();
      await page.screenshot({ path: info.outputPath('back-preserved.png') });
      await attachProbe(info, page, probe);
      expect(probe.errors).toEqual([]);
      expect(probe.failures).toHaveLength(result === 'transport' ? 1 : 0);
      if (result !== 'transport') expect(probe.console.filter((entry) => entry.type === 'error')).toEqual([]);
      expect(probe.console.filter((entry) => /\[(AccessPage|LoginPage)\]/.test(entry.text))).toEqual([]);
    });
  }

  test(`${path}: old completion cannot unlock a new verification after Back and Forward`, async ({ page }, info) => {
    const probe = await installCaptchaFixture(page);
    const previous = await enterAuthFromPreviousPage(page, path, probe);
    const old = deferred();
    probe.plans.push({ gate: old, json: { err: 'captcha.invalid', msg: 'Old failure' } });
    const input = page.getByPlaceholder('请输入图片中的字符');
    const oldCount = probe.posts.length;
    await input.fill('wrong'); await input.press('Enter');
    await expect.poll(() => probe.posts.length).toBe(oldCount + 1);
    await page.goBack(); await expect(page).toHaveURL(previous);
    await page.goForward(); await expect(page).toHaveURL(`${authBase}/${path}`);
    const dialog = page.getByRole('dialog', { name: '安全验证' });
    if (!await dialog.isVisible()) await (await fillAuthPage(page, path)).click();
    await expect(input).toBeEnabled();
    const current = deferred();
    probe.plans.push({ gate: current, json: { err: 'captcha.invalid', msg: 'Current failure' } });
    const count = probe.posts.length;
    await input.fill('current'); await input.press('Enter');
    await expect.poll(() => probe.posts.length).toBe(count + 1);
    await releasePost(page, old);
    await expect(input).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Old failure')).toHaveCount(0);
    await releasePost(page, current);
    await expect(dialog.getByText('Current failure')).toBeVisible();
    await expect(input).toBeEnabled();
    expect(probe.posts).toHaveLength(count + 1);
    await attachProbe(info, page, probe);
    expect(probe.errors).toEqual([]);
  });
}

for (const abort of [false, true]) {
  test(`login: Back during user info ignores late ${abort ? 'failure' : 'success'}`, async ({ page }, info) => {
    const probe = await installCaptchaFixture(page);
    // Use a public previous page here: a protected library is entitled to
    // synchronize its own user after sign-in has already reached the server.
    const previous = `${authBase}/register`;
    await page.goto(previous);
    await page.getByRole('link', { name: '登录', exact: true }).click();
    await (await fillAuthPage(page, 'login')).click();
    await expect(page.getByPlaceholder('请输入图片中的字符')).toBeVisible();
    const gate = deferred();
    probe.infoPlans.push({ gate, abort });
    const before = probe.infos;
    await page.getByPlaceholder('请输入图片中的字符').fill('correct');
    await page.getByPlaceholder('请输入图片中的字符').press('Enter');
    await expect.poll(() => probe.infos).toBe(before + 1);
    await page.goBack(); await expect(page).toHaveURL(previous);
    const session = await page.evaluate(() => localStorage.getItem('moke-server-storage'));
    gate.resolve();
    const navigated = await page.waitForURL(`${authBase}/shelf`, { timeout: 1000 }).then(() => true, () => false);
    expect(navigated).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('moke-server-storage'))).toBe(session);
    await attachProbe(info, page, probe);
    expect(probe.errors).toEqual([]);
    expect(probe.failures).toHaveLength(abort ? 1 : 0);
    // A deliberate transport failure can log in the request layer, but the
    // inactive login page must not report a new failure or log out the session.
    expect(probe.console.filter((entry) => entry.text.includes('[LoginPage]'))).toEqual([]);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`opaque keyboard ${viewport.width}`, () => {
    test.use({ viewport });
    for (const provider of ['webcode', 'geetest']) {
      test(`${provider}: iframe Tab boundaries, Escape, pending and stale messages`, async ({ page }, info) => {
        const probe = await installCaptchaFixture(page, { provider });
        let dialog = await openAuthChallenge(page, 'login');
        const trigger = page.getByRole('button', { name: '登录', exact: true });
        const solve = () => dialog.frameLocator('iframe').getByRole('button', { name: provider === 'geetest' ? 'SDK challenge' : 'Solve fixture' });
        await expect(solve()).toBeVisible();
        const channel = await dialog.locator('iframe').evaluate((frame) => JSON.parse(/const channel = ("[^"]+")/.exec(frame.srcdoc)[1]));
        const focus = [];
        for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
          if (!focus.length) await solve().focus();
          await page.keyboard.press(key);
          await expect.poll(() => page.evaluate(() => document.querySelector('dialog').contains(document.activeElement))).toBe(true);
          focus.push({ key, ...await page.evaluate(() => ({ tag: document.activeElement.tagName, inDialog: document.querySelector('dialog').contains(document.activeElement) })) });
        }
        await solve().evaluate(() => {
          const extra = document.createElement('button'); extra.textContent = 'Extra frame control'; document.body.appendChild(extra);
        });
        await solve().focus(); await page.keyboard.press('Tab');
        await expect(dialog.frameLocator('iframe').getByRole('button', { name: 'Extra frame control' })).toBeFocused();
        await page.keyboard.press('Shift+Tab'); await expect(solve()).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeFocused();
        // A native modal still prevents programmatic focus on its background.
        await trigger.evaluate((element) => element.focus());
        expect(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement))).toBe(true);
        await solve().focus(); await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
        await trigger.click(); dialog = page.getByRole('dialog', { name: '安全验证' });
        await expect(solve()).toBeVisible(); await solve().focus();
        const currentChannel = await dialog.locator('iframe').evaluate((frame) => JSON.parse(/const channel = ("[^"]+")/.exec(frame.srcdoc)[1]));
        expect(currentChannel).not.toBe(channel);
        // Exercise the actual current frame with an old/wrong channel, and
        // the right channel from a wrong WindowProxy. No command may act.
        await solve().evaluate((_, oldChannel) => {
          for (const type of ['success', 'dismiss', 'focus']) parent.postMessage({ kind: 'moke-captcha-sandbox-v1', channel: oldChannel, type, payload: type === 'dismiss' ? null : 'forward' }, '*');
        }, channel);
        await page.evaluate((current) => window.postMessage({ kind: 'moke-captcha-sandbox-v1', channel: current, type: 'dismiss', payload: null }, '*'), currentChannel);
        await solve().focus(); await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeFocused();
        await expect(dialog).toBeVisible(); expect(probe.posts).toHaveLength(2);
        const gate = deferred();
        probe.plans.push({ gate, json: { err: 'captcha.invalid', msg: 'Fixture rejected challenge' } });
        await solve().click(); await expect.poll(() => probe.posts.length).toBe(3);
        await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeDisabled();
        await solve().focus(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
        await releasePost(page, gate);
        await expect(dialog.getByText('Fixture rejected challenge')).toBeVisible();
        await expect(dialog.getByRole('button', { name: '关闭安全验证' })).toBeEnabled();
        await info.attach('frame-focus.json', { body: JSON.stringify(focus), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('iframe-keyboard.png') });
        await solve().click(); await expect(page).toHaveURL(`${authBase}/shelf`);
        expect(probe.posts).toHaveLength(4);
        await attachProbe(info, page, probe);
        expect(probe.errors).toEqual([]); expect(probe.failures).toEqual([]);
        expect(probe.console.filter((entry) => entry.type === 'error')).toEqual([]);
      });
    }
  });
}
