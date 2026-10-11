import {test,expect} from '@playwright/test';
import {installServerListFixture} from './helpers/server-list-fixture.mjs';
const base=process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{
    localStorage.setItem('moke-privacy-consent','2026-08-14');
    localStorage.setItem('moke-server-storage',JSON.stringify({version:1,state:{savedServers:[{id:'a',url:'https://a.example.test',title:'A',addedAt:''}]}}));
  });
});
for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
  test(`cold auth pages explain missing connection and disable submission ${viewport.width}`,async({page})=>{
    await page.setViewportSize(viewport);const fixture=await installServerListFixture(page);
    for(const path of ['/login','/register','/reset-password']) {
      await page.goto(base+path,{waitUntil:'domcontentloaded'});
      await expect(page.getByRole('alert').filter({hasText:'连接信息已失效'})).toBeVisible();
      await page.getByPlaceholder('请输入用户名',{exact:true}).fill('fixture-reader');
      if(path==='/reset-password')await page.getByPlaceholder('请输入注册时的邮箱').fill('reader@example.test');
      else await page.getByPlaceholder('请输入密码',{exact:true}).fill('fixture-password');
      await expect(page.locator('button[type="submit"]')).toBeDisabled();
      await page.reload({waitUntil:'domcontentloaded'});
      await expect(page.getByRole('alert').filter({hasText:'连接信息已失效'})).toBeVisible();
    }
    await page.getByRole('link',{name:'返回服务器列表',exact:true}).click();
    await expect(page).toHaveURL(/\/welcome$/);await expect(page.locator('li')).toHaveCount(1);expect(fixture.requests).toHaveLength(0);
    await page.goto(base+'/login',{waitUntil:'domcontentloaded'});
    await page.getByRole('link',{name:'忘记密码？',exact:true}).click();
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole('alert').filter({hasText:'连接信息已失效'})).toBeVisible();
  });
}

for(const form of ['login','access']) {
  test(`${form} displays safe errors for invalid server responses and logs the failed operation`,async({page})=>{
    const fixture=await installServerListFixture(page), warnings=[];
    page.on('console',message=>{if(message.type()==='warning')warnings.push(message.text());});
    const server=fixture.servers.get(fixture.origins[0]);server.loggedIn=false;
    server.invited=form==='login';
    await page.goto(base+'/welcome',{waitUntil:'domcontentloaded'});
    await page.locator('li button').first().click();
    if(form==='login') {
      await page.getByRole('link',{name:'登录',exact:true}).click();
      await page.getByPlaceholder('请输入用户名',{exact:true}).fill('fixture-reader');
      await page.getByPlaceholder('请输入密码',{exact:true}).fill('fixture-password');
      await page.route('**/api/user/sign_in',route=>route.fulfill({contentType:'text/html',body:'<html><body>internal gateway page</body></html>'}));
    }else{
      await page.getByPlaceholder('请输入访问码').fill('fixture-code');
      await page.route('**/api/welcome',route=>route.fulfill({contentType:'text/html',body:'<html><body>internal gateway page</body></html>'}));
    }
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText('服务器返回内容无效。',{exact:true})).toBeVisible();
    await expect(page.getByText(/Unexpected token|internal gateway|DOCTYPE/)).toHaveCount(0);
    expect(warnings.some(message=>message.includes(form==='login'?'[LoginPage] login flow failed':'[AccessPage] access verification failed'))).toBe(true);
  });
}
