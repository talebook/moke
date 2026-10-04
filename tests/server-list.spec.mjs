import { test, expect } from '@playwright/test';
import { installServerListFixture } from './helpers/server-list-fixture.mjs';
const base=process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';

async function start(page) {
  await page.goto(`${base}/`);
  await page.getByRole('button',{name:'同意并继续',exact:true}).click();
  await expect(page.getByRole('heading',{name:'服务器',exact:true})).toBeVisible();
}
async function save(page,url) {
  await page.getByRole('button',{name:'加入服务器',exact:true}).click();
  await expect(page.getByLabel('服务器地址',{exact:true})).toBeFocused();
  await page.getByLabel('服务器地址',{exact:true}).fill(url);
  await page.getByRole('button',{name:'保存到列表',exact:true}).click();
  await expect(page.getByRole('button',{name:'加入服务器',exact:true})).toBeVisible();
}
async function list(page) { await page.getByRole('link').filter({hasText:'服务器列表'}).filter({visible:true}).first().click(); }

for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
  test(`save A/B, restart storage, authenticate and switch ${viewport.width}`,async({page,browser})=>{
    await page.setViewportSize(viewport);
    const fixture=await installServerListFixture(page);
    await start(page);
    await save(page,fixture.origins[0]);await save(page,fixture.origins[1]);
    expect(fixture.requests).toHaveLength(0);
    const before=await page.evaluate(()=>localStorage.getItem('moke-server-storage'));
    await page.reload();await expect(page.locator('li')).toHaveCount(2);
    expect(await page.evaluate(()=>localStorage.getItem('moke-server-storage'))).toBe(before);
    const actualStorage=await page.context().storageState();
    const second=await browser.newContext({storageState:actualStorage,viewport});
    const reopened=await second.newPage();
    try {await reopened.goto(base);await expect(reopened.locator('li')).toHaveCount(2);expect(await reopened.evaluate(()=>localStorage.getItem('moke-server-storage'))).toBe(before);}finally{await second.close();}
    await page.locator('li button').first().click();
    await expect(page).toHaveURL(/\/shelf/);await expect(page.getByText('A 同编号藏书').first()).toBeVisible();
    if(viewport.width<1024){await page.getByRole('link',{name:'我的',exact:true}).click();await page.getByRole('link',{name:'前往设置',exact:true}).click();}
    await list(page);
    await page.locator('li button').nth(1).click();await expect(page).toHaveURL(/\/access\?/);
    await page.getByRole('button',{name:'返回',exact:true}).click();
    await expect(page).toHaveURL(/\/welcome/);await expect(page.getByText('当前服务器',{exact:true})).toBeVisible();
    await page.locator('li button').nth(1).click();await page.getByPlaceholder('请输入访问码').fill('fixture-code');await page.getByRole('button',{name:'确认',exact:true}).click();
    await expect(page).toHaveURL(/\/shelf/);await expect(page.getByText('B 同编号藏书').first()).toBeVisible();
    await expect(page.getByText('A 同编号藏书',{exact:true})).toHaveCount(0);
  });
}

test('duplicate, invalid root, cancellation, storage failure and recovery',async({page})=>{
  const fixture=await installServerListFixture(page);await start(page);
  await save(page,fixture.origins[0]);await save(page,'https://A.example.test:443/');await expect(page.locator('li')).toHaveCount(1);
  await page.getByRole('button',{name:'加入服务器',exact:true}).click();for(const address of ['https://a.example.test/path','https://a.example.test/path/..']){await page.getByLabel('服务器地址',{exact:true}).fill(address);await page.getByRole('button',{name:'保存到列表',exact:true}).click();await expect(page.getByText(/请填写服务器根地址/)).toBeVisible();}await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('button',{name:'加入服务器',exact:true})).toBeFocused();
  await page.evaluate(()=>{window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='moke-server-storage')throw new DOMException('quota','QuotaExceededError');return window.originalStorageSet.call(this,key,value);};});
  await page.getByRole('button',{name:'加入服务器',exact:true}).click();await page.getByLabel('服务器地址',{exact:true}).fill(fixture.origins[1]);await page.getByRole('button',{name:'保存到列表',exact:true}).click();await expect(page.getByText(/未保存/)).toBeVisible();await expect(page.locator('li')).toHaveCount(1);
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalStorageSet;});await page.getByRole('button',{name:'保存到列表',exact:true}).click();await expect(page.locator('li')).toHaveCount(2);
  fixture.servers.get(fixture.origins[1]).fault='delay';await page.locator('li button').nth(1).click();await page.getByRole('button',{name:'取消连接',exact:true}).click();fixture.release();await expect(page).toHaveURL(/\/welcome/);await expect(page.locator('li')).toHaveCount(2);
  fixture.servers.get(fixture.origins[1]).fault='busy';await page.locator('li button').nth(1).click();await expect(page.getByText(/模拟繁忙/)).toBeVisible();await expect(page.locator('li')).toHaveCount(2);
  await page.evaluate(()=>localStorage.setItem('moke-server-storage','{broken'));await page.reload();await expect(page.getByText(/无法加载服务器列表/)).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('moke-server-storage'))).toBe('{broken');await page.getByRole('button',{name:'保留原数据并重建列表',exact:true}).click();await expect(page.getByText('尚未加入服务器')).toBeVisible();expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('moke-server-storage-backup-')).length)).toBe(1);
});

test('legacy migration, timeout, retry and B login retain source identity',async({page})=>{
  const fixture=await installServerListFixture(page);
  await page.goto(base);
  await page.evaluate(()=>localStorage.setItem('moke-server-storage',JSON.stringify({version:0,state:{serverUrl:'https://A.example.test:443/',serverTitle:'旧 A'}})));
  await page.getByRole('button',{name:'同意并继续',exact:true}).click();
  await expect(page.locator('li')).toHaveCount(1);
  const migrated=await page.evaluate(()=>localStorage.getItem('moke-server-storage'));
  await page.reload();await expect(page.locator('li')).toHaveCount(1);
  expect(await page.evaluate(()=>localStorage.getItem('moke-server-storage'))).toBe(migrated);
  await save(page,fixture.origins[1]);
  fixture.servers.get(fixture.origins[1]).fault='delay';
  await page.locator('li button').nth(1).click();
  await expect(page.locator('#server-error')).toContainText('连接超时',{timeout:25000});
  fixture.release();fixture.servers.get(fixture.origins[1]).fault=null;
  await page.locator('li button').nth(1).click();
  await page.getByPlaceholder('请输入访问码').fill('fixture-code');await page.getByRole('button',{name:'确认',exact:true}).click();
  await expect(page.getByText('B 同编号藏书').first()).toBeVisible();
  await page.getByRole('link',{name:'登录',exact:true}).click();
  await page.getByPlaceholder('请输入用户名').fill('fixture-reader');await page.getByPlaceholder('请输入密码').fill('fixture-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByText('B 测试读者',{exact:true})).toBeVisible();
  await list(page);await page.locator('li button').first().click();await expect(page.getByText('A 测试读者',{exact:true})).toBeVisible();
  expect(fixture.requests.filter(r=>r.path==='/api/user/sign_in').map(r=>r.origin)).toEqual([fixture.origins[1]]);
});
