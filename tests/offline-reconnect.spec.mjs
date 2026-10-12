import { test, expect } from '@playwright/test';
import { startOfflineReconnect, openReconnectSettings, RECONNECT_SERVER, OTHER_RECONNECT_SERVER } from './helpers/offline-reconnect.mjs';
import { clickAppLink } from './helpers/offline-mode-fixture.mjs';

const base=process.env.MOKE_TAURI_TEST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';
test.setTimeout(60000);
const requests=page => page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.requests);
const settings=async page => {await openReconnectSettings(page);return page.locator('.moke-route-content');};
const connect=page => page.locator('aside').getByRole('button',{name:'连接服务器',exact:true});
const offline=page => page.viewportSize().width < 1024
  ? expect(page.locator('.moke-tab-bar').getByRole('link',{name:'设置',exact:true})).toBeVisible()
  : expect(page.locator('aside').getByRole('button',{name:'连接服务器',exact:true})).toHaveCount(1);
const online=page => page.viewportSize().width < 1024
  ? expect(page.locator('.moke-tab-bar').getByRole('link',{name:'我的',exact:true})).toBeVisible()
  : expect(page.locator('aside').getByRole('button',{name:'连接服务器',exact:true})).toHaveCount(0);

for (const width of [1280,390]) test(`已连接→离线→恢复原服务器，保留会话 ${width}`,async ({page}) => {
  await page.setViewportSize({width,height:900});await startOfflineReconnect(page,base,{offlineMode:false});
  const list=await page.evaluate(() => localStorage.getItem('moke-server-storage'));
  let content=await settings(page);await content.getByRole('button',{name:'进入离线模式',exact:true}).click();
  await offline(page);content=await settings(page);
  await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await expect(page).toHaveURL(/\/shelf$/);await online(page);
  await expect(page.locator('aside').getByText('fixture-reader',{exact:true})).toHaveCount(1);
  expect((await requests(page)).every(url => url.startsWith(RECONNECT_SERVER+'/'))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('moke-server-storage'))).toBe(list);
});

test('退出无当前连接的离线模式不能把保存列表或兼容镜像当作已确认连接',async ({page}) => {
  await startOfflineReconnect(page,base,{serverUrl:'',cachedUser:false,fallback:RECONNECT_SERVER});
  const content=await settings(page);await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await expect(page).toHaveURL(/\/welcome$/);expect(await requests(page)).toHaveLength(0);
  await page.locator('li button').filter({hasText:OTHER_RECONNECT_SERVER}).click();
  await expect(page).toHaveURL(/\/shelf$/);
});

test('保存列表冷启动始终要求明确连接',async ({page}) => {
  await startOfflineReconnect(page,base);await page.reload();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.locator('li')).toHaveCount(2);
});

for (const activation of ['click','Enter','Space']) test(`侧栏通过${activation}恢复原服务器`,async ({page}) => {
  await page.setViewportSize({width:1280,height:900});await startOfflineReconnect(page,base);
  if (activation==='click') await connect(page).click();
  else {await connect(page).focus();await page.keyboard.press(activation);}
  await online(page);await expect(page).toHaveURL(/\/shelf$/);
  expect((await requests(page)).every(url => url.startsWith(RECONNECT_SERVER+'/'))).toBe(true);
});

test('恢复当前第二台服务器而非此前的第一台',async ({page}) => {
  await startOfflineReconnect(page,base,{serverUrl:OTHER_RECONNECT_SERVER});
  const content=await settings(page);await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await online(page);expect((await requests(page)).every(url => url.startsWith(OTHER_RECONNECT_SERVER+'/'))).toBe(true);
});

for (const mode of ['expired','access']) test(`认证${mode}通过绑定的原服务器入口恢复`,async ({page}) => {
  await startOfflineReconnect(page,base,{mode});const content=await settings(page);
  await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  if (mode==='expired') {
    await expect(page).toHaveURL(/\/login\?reconnect=1$/);
    await expect(page.getByText('登录状态已失效，请重新登录。')).toBeVisible();
  } else {
    await expect(page).toHaveURL(/\/access\?serverId=previous&requestId=\d+$/);
    await expect(page.getByPlaceholder('请输入访问码')).toBeVisible();
  }
});

for (const action of ['重试连接','选择服务器']) test(`网络失败保留离线书库，并可${action}`,async ({page}) => {
  await startOfflineReconnect(page,base,{mode:'network'});const content=await settings(page);
  await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await expect(content.getByRole('alert')).toContainText('无法恢复服务器连接');await offline(page);
  await page.evaluate(() => {window.__MOKE_RECONNECT_FIXTURE__.mode='success';});
  await content.getByRole('button',{name:action,exact:true}).click();
  if (action==='选择服务器') await expect(page).toHaveURL(/\/welcome$/);
  else {await online(page);await expect(page).toHaveURL(/\/shelf$/);}
});

test('超时释放按钮，迟到响应不能恢复已换成第二台的会话',async ({page}) => {
  await startOfflineReconnect(page,base,{mode:'hang'});const content=await settings(page);
  await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await expect(content.getByRole('alert')).toContainText('连接超时',{timeout:20000});
  await expect(content.getByRole('button',{name:'连接服务器',exact:true})).toBeEnabled();await offline(page);
  await content.getByRole('button',{name:'选择服务器',exact:true}).click();
  await page.evaluate(() => {window.__MOKE_RECONNECT_FIXTURE__.mode='success';});
  await page.locator('li button').filter({hasText:OTHER_RECONNECT_SERVER}).click();await expect(page).toHaveURL(/\/shelf$/);
  await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.release());await online(page);
  const settingsContent=await settings(page);
  await expect(settingsContent.getByText(OTHER_RECONNECT_SERVER,{exact:true})).toBeVisible();
});

test('侧栏与设置页共用在途请求，取消旧请求不释放新请求',async ({page}) => {
  await page.setViewportSize({width:1280,height:900});await startOfflineReconnect(page,base,{mode:'hang'});
  const content=await settings(page),settingsConnect=content.getByRole('button',{name:'连接服务器',exact:true});
  await connect(page).dblclick();await expect(settingsConnect).toBeDisabled();expect(await requests(page)).toHaveLength(1);
  await page.evaluate(() => {window.__MOKE_RECONNECT_FIXTURE__.oldRelease=window.__MOKE_RECONNECT_FIXTURE__.release;});
  await page.locator('aside').getByRole('button',{name:'取消连接',exact:true}).click();await settingsConnect.click();
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  await page.evaluate(() => window.__MOKE_RECONNECT_FIXTURE__.oldRelease());
  await expect(settingsConnect).toBeDisabled();await expect(connect(page)).toBeDisabled();
  await page.evaluate(() => {window.__MOKE_RECONNECT_FIXTURE__.mode='success';window.__MOKE_RECONNECT_FIXTURE__.release();});
  await online(page);await expect(page).toHaveURL(/\/shelf$/);
});

test('离开设置页取消恢复，迟到成功保持离线且仍可重试',async ({page}) => {
  await startOfflineReconnect(page,base,{mode:'hang'});const content=await settings(page);
  await content.getByRole('button',{name:'连接服务器',exact:true}).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);await clickAppLink(page,'/shelf');
  await expect(connect(page)).toBeEnabled();
  await page.evaluate(() => {window.__MOKE_RECONNECT_FIXTURE__.mode='success';window.__MOKE_RECONNECT_FIXTURE__.release();});
  await offline(page);await connect(page).click();await online(page);
});
