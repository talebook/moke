import { test, expect } from '@playwright/test';
import { installJoinServerFixture } from './helpers/join-server-fixture.mjs';

const BASE_URL = process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';

async function openJoin(page) {
  await page.goto(`${BASE_URL}/welcome`);
  await page.getByRole('button', {name:'开始加入'}).click();
  await expect(page.getByLabel('服务器地址')).toBeFocused();
}

for (const viewport of [{width:1280, height:900}, {width:390, height:844}]) {
  test(`joining and account/library navigation at ${viewport.width}px`, async ({page}) => {
    await page.setViewportSize(viewport);
    const fixture = await installJoinServerFixture(page);
    await openJoin(page);
    await expect(page.getByRole('button', {name:'加入服务器', exact:true})).toBeDisabled();
    await page.getByLabel('服务器地址').fill('http://join.test');
    await page.getByLabel('服务器地址').press('Enter');
    await expect(page.getByRole('heading', {name:'已加入服务器'})).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.serverUrl)).toBe('http://join.test');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', {name:'登录账号'}).click();
    await page.getByPlaceholder('请输入用户名').fill('reader');
    await page.getByPlaceholder('请输入密码').fill('fictional-password');
    await page.getByRole('button', {name:'登录', exact:true}).click();
    await expect(page).toHaveURL(/\/shelf$/);
    await page.getByRole('link', {name:'书库', exact:true}).filter({visible:true}).click();
    await page.getByText('加入服务器回归示例', {exact:true}).click();
    await expect(page.getByRole('heading', {name:'加入服务器回归示例'})).toBeVisible();
    await expect(page.getByText('离线下载与离线阅读仅支持桌面版')).toBeVisible();
    expect(fixture.loggedIn).toBe(true);
    expect(fixture.requests.some(request => request.path === '/api/library')).toBe(true);
    expect(fixture.requests.some(request => request.path === '/api/book/42')).toBe(true);
  });
}

test('business failure preserves existing/offline configuration and retry succeeds', async ({page}) => {
  const fixture = await installJoinServerFixture(page, {mode:'error', savedServer:'http://saved.test:80', offlineMode:true});
  await openJoin(page);
  await page.getByLabel('服务器地址').fill('http://join.test');
  await page.getByLabel('服务器地址').press('Enter');
  await expect(page.getByRole('alert').filter({hasText:'模拟访问码检查失败'})).toBeVisible();
  await expect(page.getByLabel('服务器地址')).toBeFocused();
  expect(await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('moke-server-storage')).state;
    return {url:state.serverUrl, offline:state.offlineMode};
  })).toEqual({url:'http://saved.test:80', offline:true});
  fixture.mode = 'free';
  await page.getByRole('button', {name:'重试加入'}).click();
  await expect(page.getByRole('heading', {name:'已加入服务器'})).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.offlineMode)).toBe(false);
  await page.getByRole('button', {name:'进入书架'}).click();
  await expect(page).toHaveURL(/\/shelf$/);
});

test('loading can be cancelled with keyboard and repeated submissions do not overlap', async ({page}) => {
  const fixture = await installJoinServerFixture(page, {delay:1000});
  await openJoin(page);
  await page.getByLabel('服务器地址').fill('http://join.test');
  await page.getByLabel('服务器地址').press('Enter');
  await expect(page.getByRole('button', {name:'取消加入'})).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('正在验证服务器与访问权限…');
  await expect.poll(() => fixture.requests.filter(request => request.path === '/api/user/info').length).toBe(1);
  await page.locator('form').evaluate(form => {
    form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
    form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
  });
  await page.getByRole('button', {name:'取消加入'}).press('Enter');
  await expect(page.getByRole('button', {name:'开始加入'})).toBeFocused();
  // Ensure the delayed response has completed before checking it was ignored.
  await page.waitForTimeout(1200);
  await expect(page.getByRole('heading', {name:'已加入服务器'})).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage'))?.state.serverUrl || '')).toBe('');
  expect(fixture.requests.filter(request => request.path === '/api/user/info')).toHaveLength(1);
});

test('access-code server uses the existing access flow', async ({page}) => {
  await installJoinServerFixture(page, {mode:'access'});
  await openJoin(page);
  await page.getByLabel('服务器地址').fill('http://join.test');
  await page.getByLabel('服务器地址').press('Enter');
  await page.getByRole('button', {name:'继续验证访问码'}).click();
  await expect(page).toHaveURL(/\/access\?server=http%3A%2F%2Fjoin.test/);
  await page.getByPlaceholder('请输入访问码').fill('fictional-code');
  await page.getByRole('button', {name:'确认', exact:true}).click();
  await expect(page).toHaveURL(/\/shelf$/);
});

test('legacy server configuration still starts at the existing shelf', async ({page}) => {
  await installJoinServerFixture(page, {savedServer:'http://saved.test:80'});
  await page.goto(BASE_URL);
  await expect(page).toHaveURL(/\/shelf$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.serverUrl)).toBe('http://saved.test:80');
});

test('offline settings join entry preserves offline mode through cancellation', async ({page}) => {
  await installJoinServerFixture(page, {offlineMode:true});
  await page.goto(`${BASE_URL}/settings`);
  await page.getByRole('button', {name:'加入服务器', exact:true}).click();
  await page.getByRole('button', {name:'开始加入'}).click();
  await page.getByRole('button', {name:'取消加入'}).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.offlineMode)).toBe(true);
});

for (const mode of ['network', 'invalid']) {
  test(`${mode} failure does not save a server`, async ({page}) => {
    await installJoinServerFixture(page, {mode});
    await openJoin(page);
    await page.getByLabel('服务器地址').fill('http://join.test');
    await page.getByLabel('服务器地址').press('Enter');
    await expect(page.getByRole('button', {name:'重试加入'})).toBeEnabled();
    await expect(page.getByRole('heading', {name:'已加入服务器'})).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage'))?.state.serverUrl || '')).toBe('');
  });
}

test('leaving during a join ignores the delayed response', async ({page}) => {
  const fixture = await installJoinServerFixture(page, {delay:1000});
  await page.goto(`${BASE_URL}/privacy`);
  await openJoin(page);
  await page.getByLabel('服务器地址').fill('http://join.test');
  await page.getByLabel('服务器地址').press('Enter');
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(0);
  await page.goBack();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage'))?.state.serverUrl || '')).toBe('');
});

test('joining times out with a retry action', async ({page}) => {
  await installJoinServerFixture(page, {delay:25_000});
  await openJoin(page);
  await page.clock.install();
  await page.getByLabel('服务器地址').fill('http://join.test');
  await page.getByLabel('服务器地址').press('Enter');
  await page.clock.fastForward(20_001);
  await expect(page.getByRole('alert').filter({hasText:'加入超时'})).toBeVisible();
  await expect(page.getByRole('button', {name:'重试加入'})).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage'))?.state.serverUrl || '')).toBe('');
});
