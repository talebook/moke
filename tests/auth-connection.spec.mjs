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

test('login requiring a new access code rebuilds the saved candidate and reaches the access form',async({page})=>{
  const fixture=await installServerListFixture(page);
  fixture.servers.get(fixture.origins[0]).loggedIn=false;
  await page.goto(base+'/welcome',{waitUntil:'domcontentloaded'});
  await page.locator('li button').first().click();
  await page.getByRole('link',{name:'登录',exact:true}).click();
  await page.getByPlaceholder('请输入用户名',{exact:true}).fill('fixture-reader');
  await page.getByPlaceholder('请输入密码',{exact:true}).fill('fixture-password');
  await page.route('**/api/user/sign_in',route=>route.fulfill({json:{err:'user.private.not_valid'}}));
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/access\?serverId=a&requestId=\d+$/);
  await page.getByPlaceholder('请输入访问码').fill('fixture-code');
  await expect(page.getByRole('button',{name:'确认',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'确认',exact:true}).click();
  await expect(page).toHaveURL(/\/shelf$/);
});

test('not_invited from a saved-server welcome probe requires an access code before activation', async ({page}) => {
  const fixture = await installServerListFixture(page);
  const server = fixture.servers.get(fixture.origins[0]);
  server.invited = false;
  server.loggedIn = false;
  server.welcomeErr = 'not_invited';
  await page.goto(base + '/welcome', {waitUntil:'domcontentloaded'});
  await page.locator('li button').first().click();
  await expect(page).toHaveURL(/\/access\?serverId=a&requestId=\d+$/);
  expect(fixture.requests.some(request => request.path === '/api/shelf')).toBe(false);
  await page.getByPlaceholder('请输入访问码').fill('fixture-code');
  await page.getByRole('button', {name:'确认',exact:true}).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await expect(page.getByText('A 同编号藏书').first()).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/welcome' && request.method === 'POST').map(request => request.origin)).toEqual([fixture.origins[0]]);
});

test('not_invited during provider access confirmation rebuilds the active candidate and reaches access', async ({page}) => {
  const fixture = await installServerListFixture(page);
  const server = fixture.servers.get(fixture.origins[0]);
  let welcomeGets = 0;
  await page.route(fixture.origins[0] + '/api/welcome', async route => {
    // Initial connection is open. The subsequent provider check observes an
    // expired invite; a successful POST reopens the same server's session.
    if (route.request().method() === 'GET' && ++welcomeGets === 2) {
      server.invited = false;
      server.welcomeErr = 'not_invited';
    }
    await route.fallback();
  });
  await page.goto(base + '/welcome', {waitUntil:'domcontentloaded'});
  await page.locator('li button').first().click();
  await expect(page).toHaveURL(/\/access\?serverId=a&requestId=\d+$/);
  expect(welcomeGets).toBeGreaterThanOrEqual(2);
  await page.getByPlaceholder('请输入访问码').fill('fixture-code');
  await page.getByRole('button', {name:'确认',exact:true}).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await expect(page.getByText('A 同编号藏书').first()).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/welcome' && request.method === 'POST').map(request => request.origin)).toEqual([fixture.origins[0]]);
});

for (const staleResult of ['ok', 'captcha.required']) {
  test(`reset aborts on leaving and ignores delayed A ${staleResult} while B submits`, async ({page}) => {
    const fixture = await installServerListFixture(page);
    for (const server of fixture.servers.values()) {server.loggedIn = false; server.invited = true;}
    // Simulate a transport that delivers a response despite an aborted signal.
    // The app still renders with real React/store/router and reads real storage.
    await page.addInitScript(() => {
      const fetchRequest = window.fetch.bind(window);
      window.resetRequests = [];
      window.fetch = (input, options) => {
        if (String(input).endsWith('/api/user/reset')) {
          return new Promise(resolve => window.resetRequests.push({
            url:String(input), signal:options.signal,
            finish:data => resolve(new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}})),
          }));
        }
        return fetchRequest(input, options);
      };
    });
    await page.goto(base + '/welcome', {waitUntil:'domcontentloaded'});
    await page.getByRole('button', {name:'加入服务器',exact:true}).click();
    await page.getByLabel('服务器地址', {exact:true}).fill(fixture.origins[1]);
    await page.getByRole('button', {name:'保存到列表',exact:true}).click();
    await expect(page.locator('li')).toHaveCount(2);
    await page.locator('li button').first().click();
    await page.getByRole('link', {name:'登录',exact:true}).click();
    await page.getByRole('link', {name:'忘记密码？',exact:true}).click();
    await page.getByPlaceholder('请输入注册时的邮箱').fill('a@example.test');
    await page.getByPlaceholder('请输入用户名', {exact:true}).fill('reader-A');
    await page.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.resetRequests.length)).toBe(1);
    expect(await page.evaluate(() => window.resetRequests[0].url)).toBe(fixture.origins[0] + '/api/user/reset');
    await page.getByRole('button', {name:'返回登录',exact:true}).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => page.evaluate(() => window.resetRequests[0].signal.aborted)).toBe(true);
    await page.getByRole('button', {name:'返回',exact:true}).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await page.locator('li button').nth(1).click();
    await page.getByRole('link', {name:'登录',exact:true}).click();
    await page.getByRole('link', {name:'忘记密码？',exact:true}).click();
    await page.getByPlaceholder('请输入注册时的邮箱').fill('b@example.test');
    await page.getByPlaceholder('请输入用户名', {exact:true}).fill('reader-B');
    await page.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.resetRequests.length)).toBe(2);
    expect(await page.evaluate(() => window.resetRequests[1].url)).toBe(fixture.origins[1] + '/api/user/reset');
    await page.evaluate(err => window.resetRequests[0].finish({err,msg:'旧 A 的验证码'}), staleResult);
    await expect(page.locator('button[type="submit"]')).toHaveText('提交中...');
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
    await expect(page.getByText('旧 A 的验证码', {exact:true})).toHaveCount(0);
    await expect(page.getByText('新密码已发送到您的邮箱，请查收并使用新密码登录。', {exact:true})).toHaveCount(0);
    await page.evaluate(() => window.resetRequests[1].finish({err:'ok'}));
    await expect(page.getByText('新密码已发送到您的邮箱，请查收并使用新密码登录。', {exact:true})).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });
}
