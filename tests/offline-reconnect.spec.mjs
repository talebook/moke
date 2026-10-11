import { test, expect as baseExpect } from '@playwright/test';
import { installOfflineReconnectMock, RECONNECT_SERVER } from './helpers/offline-reconnect.mjs';

const expect = baseExpect.configure({ timeout: 15_000 });
const APP_URL = process.env.PLAYWRIGHT_BASE_URL || process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`已连接 → 离线 → 自动恢复原服务器 (${viewport.width})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installOfflineReconnectMock(page);
    await page.goto(`${APP_URL}/settings`);
    await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    await expect(page.getByText('布局回归测试书籍', { exact: true }).first()).toBeVisible();
    expect((await stored(page)).offlineMode).toBe(true);
    await page.getByRole('link', { name: '设置', exact: true }).first().click();
    await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    const state = await stored(page);
    expect(state.serverUrl).toBe(RECONNECT_SERVER);
    expect(state.offlineMode).toBe(false);
    expect(state.isConnected).toBe(true);
    expect(state.token).toBe('fictional-token');
    await page.screenshot({ path: testInfo.outputPath(`restored-${viewport.width}.png`), fullPage: true });
  });
}

test('连接界面直接进入离线，恢复已有服务器而不覆盖它', async ({ page }) => {
  await installOfflineReconnectMock(page);
  await page.goto(`${APP_URL}/welcome`);
  await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  expect((await stored(page)).serverUrl).toBe(RECONNECT_SERVER);
  expect(await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.requests.every((url) => url.startsWith('https://previous.books.test/')))).toBe(true);
});

test('连接第二台服务器后进入离线，恢复第二台而不是旧服务器', async ({ page }) => {
  await installOfflineReconnectMock(page);
  await page.goto(`${APP_URL}/welcome`);
  await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.evaluate(() => { window.__MOKE_RECONNECT_FIXTURE__.requests = []; });
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  expect((await stored(page)).serverUrl).toBe('https://other.books.test:443');
  expect(await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.requests.every((url) => new URL(url).hostname === 'other.books.test'))).toBe(true);
});

test('连接界面无可恢复配置时回到连接界面，可正常手动连接', async ({ page }, testInfo) => {
  await installOfflineReconnectMock(page, { serverUrl: '', cachedUser: false });
  await page.goto(`${APP_URL}/welcome`);
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.screenshot({ path: testInfo.outputPath('no-server-welcome.png'), fullPage: true });
  await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  expect((await stored(page)).serverUrl).toBe('https://other.books.test:443');
});

test('恢复 WebView 的备用地址；断开连接后不再恢复旧地址', async ({ page }) => {
  await installOfflineReconnectMock(page, { serverUrl: '', cachedUser: false, fallback: RECONNECT_SERVER });
  await page.goto(`${APP_URL}/welcome`);
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  expect((await stored(page)).serverUrl).toBe(RECONNECT_SERVER);
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(await page.evaluate(() => localStorage.getItem('moke_server_url'))).toBeNull();
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  expect((await stored(page)).serverUrl).toBe('');
});

for (const mode of ['expired', 'access']) {
  test(`认证失效时回到${mode === 'expired' ? '登录' : '访问码'}入口`, async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, mode });
    await page.goto(`${APP_URL}/settings`);
    await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
    await expect(page).toHaveURL(mode === 'expired' ? /\/login\?reconnect=1$/ : /\/access\?server=/);
    if (mode === 'expired') await expect(page.getByText('登录状态已失效，请重新登录。')).toBeVisible();
  });
}

test('网络失败保留离线书库和凭据，可重试或选择服务器', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installOfflineReconnectMock(page, { offlineMode: true, mode: 'network' });
  await page.goto(`${APP_URL}/settings`);
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '无法恢复服务器连接' })).toBeVisible();
  const state = await stored(page);
  expect(state.offlineMode).toBe(true);
  expect(state.serverUrl).toBe(RECONNECT_SERVER);
  expect(state.token).toBe('fictional-token');
  // Expected transport errors add Next's dev-only issues badge over the
  // mobile tab bar. Collapse that badge using its normal UI control.
  const badge = page.getByRole('button', { name: 'Collapse issues badge' });
  if (await badge.isVisible()) await badge.click();
  await page.screenshot({ path: testInfo.outputPath('network-failure-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: '书架', exact: true }).first().click();
  await expect(page.getByText('布局回归测试书籍', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: '设置', exact: true }).first().click();
  await page.evaluate(() => { window.__MOKE_RECONNECT_FIXTURE__.mode = 'success'; });
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
});

test('超时后释放按钮，忽略迟到响应并允许选择其他服务器', async ({ page }) => {
  await installOfflineReconnectMock(page, { offlineMode: true, mode: 'hang' });
  await page.goto(`${APP_URL}/settings`);
  await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在恢复服务器连接…');
  await expect(page.getByRole('alert').filter({ hasText: '连接超时' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true })).toBeEnabled();
  await page.evaluate(() => { const fixture = window.__MOKE_RECONNECT_FIXTURE__; fixture.mode = 'success'; fixture.release(); });
  expect((await stored(page)).offlineMode).toBe(true);
  await page.locator('.moke-route-content').getByRole('button', { name: '选择服务器', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
});

test.describe('桌面侧栏恢复离线服务器', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  const sidebar = (page) => page.locator('aside');
  const connect = (page) => sidebar(page).getByRole('button', { name: '连接服务器', exact: true });
  const fixtureRequests = (page) => page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.requests);
  const assertRetained = async (page) => {
    const state = await stored(page);
    expect(state.offlineMode).toBe(true);
    expect(state.isConnected).toBe(false);
    expect(state.serverUrl).toBe(RECONNECT_SERVER);
    expect(state.token).toBe('fictional-token');
    expect(state.user.username).toBe('fixture-reader');
  };

  for (const activation of ['click', 'Enter', 'Space']) {
    test(`通过 ${activation} 自动恢复原服务器和有效会话`, async ({ page }) => {
      await installOfflineReconnectMock(page, { offlineMode: true });
      await page.goto(`${APP_URL}/shelf`);
      await expect(page.getByText('布局回归测试书籍', { exact: true }).first()).toBeVisible();
      if (activation === 'click') await connect(page).click();
      else {
        await connect(page).focus();
        await expect(connect(page)).toBeFocused();
        await page.keyboard.press(activation);
      }
      await expect.poll(async () => (await stored(page)).offlineMode).toBe(false);
      await expect(page).toHaveURL(/\/shelf$/);
      const state = await stored(page);
      expect(state.serverUrl).toBe(RECONNECT_SERVER);
      expect(state.isConnected).toBe(true);
      expect(state.token).toBe('fictional-token');
      expect(state.user.username).toBe('fixture-reader');
      expect((await fixtureRequests(page)).every((url) => url.startsWith(`${RECONNECT_SERVER}/`))).toBe(true);
    });
  }

  test('已手动切换到第二台服务器时恢复当前配置', async ({ page }) => {
    await installOfflineReconnectMock(page);
    await page.goto(`${APP_URL}/welcome`);
    await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    await sidebar(page).getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    await page.evaluate(() => { window.__MOKE_RECONNECT_FIXTURE__.requests = []; });
    await connect(page).click();
    await expect.poll(async () => (await stored(page)).offlineMode).toBe(false);
    expect((await stored(page)).serverUrl).toBe('https://other.books.test:443');
    expect((await fixtureRequests(page)).every((url) => new URL(url).hostname === 'other.books.test')).toBe(true);
  });

  test('无配置时进入欢迎页，可完成手动连接', async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, serverUrl: '', cachedUser: false });
    await page.goto(`${APP_URL}/shelf`);
    await connect(page).click();
    await expect(page).toHaveURL(/\/welcome$/);
    expect((await stored(page)).offlineMode).toBe(false);
    expect(await fixtureRequests(page)).toHaveLength(0);
    await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    expect((await stored(page)).serverUrl).toBe('https://other.books.test:443');
  });

  for (const mode of ['expired', 'access']) {
    test(`${mode} 时进入正确的认证回退页面`, async ({ page }) => {
      await installOfflineReconnectMock(page, { offlineMode: true, mode });
      await page.goto(`${APP_URL}/shelf`);
      await connect(page).click();
      await expect(page).toHaveURL(mode === 'expired' ? /\/login\?reconnect=1$/ : /\/access\?server=/);
      expect((await stored(page)).serverUrl).toBe(RECONNECT_SERVER);
      if (mode === 'expired') {
        await expect(page.getByText('登录状态已失效，请重新登录。')).toBeVisible();
      } else {
        expect(new URL(page.url()).searchParams.get('server')).toBe(RECONNECT_SERVER);
        expect((await stored(page)).token).toBe('fictional-token');
      }
    });
  }

  for (const action of ['重试连接', '选择服务器']) {
    test(`网络失败保留书库、配置和会话，可${action}`, async ({ page }, testInfo) => {
      await installOfflineReconnectMock(page, { offlineMode: true, mode: 'network' });
      await page.goto(`${APP_URL}/shelf`);
      await connect(page).click();
      await expect(sidebar(page).getByRole('alert')).toContainText('无法恢复服务器连接');
      await assertRetained(page);
      await expect(page.getByText('布局回归测试书籍', { exact: true }).first()).toBeVisible();
      // Next's development error badge overlaps the footer after fixture failures.
      const badge = page.getByRole('button', { name: 'Collapse issues badge' });
      if (await badge.isVisible()) await badge.click();
      await page.screenshot({ path: testInfo.outputPath('sidebar-network-error.png'), fullPage: true });
      await page.evaluate(() => { window.__MOKE_RECONNECT_FIXTURE__.mode = 'success'; });
      await sidebar(page).getByRole('button', { name: action, exact: true }).click();
      if (action === '选择服务器') {
        await expect(page).toHaveURL(/\/welcome$/);
        expect((await stored(page)).serverUrl).toBe(RECONNECT_SERVER);
      } else {
        await expect.poll(async () => (await stored(page)).offlineMode).toBe(false);
        await expect(page).toHaveURL(/\/shelf$/);
      }
    });
  }

  test('15 秒超时释放按钮，迟到响应不能覆盖新服务器会话', async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, mode: 'hang' });
    await page.goto(`${APP_URL}/shelf`);
    await connect(page).click();
    await expect(sidebar(page).getByRole('status')).toHaveText('正在恢复服务器连接…');
    await expect(sidebar(page).getByRole('alert')).toContainText('连接超时', { timeout: 20_000 });
    await expect(connect(page)).toBeEnabled();
    await assertRetained(page);
    await sidebar(page).getByRole('button', { name: '选择服务器', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await page.evaluate(() => { window.__MOKE_RECONNECT_FIXTURE__.mode = 'success'; });
    await page.getByPlaceholder('http://192.168.1.100:8080').fill('https://other.books.test');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page).toHaveURL(/\/shelf$/);
    await expect.poll(async () => (await stored(page)).user?.username).toBe('fixture-reader');
    const newSession = await stored(page);
    await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.release());
    // Observe the state after another real navigation, allowing promise cleanup.
    await sidebar(page).getByRole('link', { name: '设置', exact: true }).click();
    const final = await stored(page);
    expect(final.serverUrl).toBe(newSession.serverUrl);
    expect(final.sessionRevision).toBe(newSession.sessionRevision);
    expect(final.user).toEqual(newSession.user);
    expect(final.token).toBe(newSession.token);
    expect(final.offlineMode).toBe(false);
  });

  test('重复点击和设置页共用一次请求；取消后旧清理不释放新请求', async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, mode: 'hang' });
    await page.goto(`${APP_URL}/settings`);
    await connect(page).dblclick();
    const settingsConnect = page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true });
    await expect(connect(page)).toBeDisabled();
    await expect(settingsConnect).toBeDisabled();
    expect(await fixtureRequests(page)).toHaveLength(1);
    await page.evaluate(() => { const fixture = window.__MOKE_RECONNECT_FIXTURE__; fixture.oldRelease = fixture.release; });
    await sidebar(page).getByRole('button', { name: '取消连接', exact: true }).click();
    await assertRetained(page);
    await settingsConnect.click();
    await expect.poll(async () => (await fixtureRequests(page)).length).toBe(2);
    await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.oldRelease());
    await expect(connect(page)).toBeDisabled();
    await expect(settingsConnect).toBeDisabled();
    await assertRetained(page);
    await page.evaluate(() => { const fixture = window.__MOKE_RECONNECT_FIXTURE__; fixture.mode = 'success'; fixture.release(); });
    await expect(page).toHaveURL(/\/shelf$/);
    expect((await stored(page)).offlineMode).toBe(false);
  });

  test('设置页卸载取消恢复，侧栏可重新尝试，迟到响应保持离线', async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, mode: 'hang' });
    await page.goto(`${APP_URL}/settings`);
    await page.locator('.moke-route-content').getByRole('button', { name: '连接服务器', exact: true }).click();
    await expect.poll(async () => (await fixtureRequests(page)).length).toBe(1);
    await sidebar(page).getByRole('link', { name: '书架', exact: true }).click();
    await expect(connect(page)).toBeEnabled();
    await page.evaluate(() => { const fixture = window.__MOKE_RECONNECT_FIXTURE__; fixture.mode = 'success'; fixture.release(); });
    await expect(page.getByText('布局回归测试书籍', { exact: true }).first()).toBeVisible();
    await assertRetained(page);
    await connect(page).click();
    await expect.poll(async () => (await stored(page)).offlineMode).toBe(false);
  });

  test('侧栏卸载也取消请求，迟到响应不能退出离线模式', async ({ page }) => {
    await installOfflineReconnectMock(page, { offlineMode: true, mode: 'hang' });
    await page.goto(`${APP_URL}/settings`);
    await connect(page).click();
    await expect.poll(async () => (await fixtureRequests(page)).length).toBe(1);
    await page.locator('.moke-route-content').getByRole('link', { name: /隐私政策/ }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.evaluate(() => { const fixture = window.__MOKE_RECONNECT_FIXTURE__; fixture.mode = 'success'; fixture.release(); });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(connect(page)).toBeEnabled();
    await assertRetained(page);
  });
});
