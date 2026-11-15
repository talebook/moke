// Fictional API/SDK responses for browser lifecycle and keyboard regressions.
export const authBase = process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

export async function installCaptchaFixture(page, { provider = 'image', ordinary = false } = {}) {
  const probe = { posts: [], plans: [], infoPlans: [], configPlans: [], errors: [], failures: [], console: [], loggedIn: false, infos: 0 };
  page.on('pageerror', (error) => probe.errors.push(error.message));
  page.on('console', (message) => probe.console.push({ type: message.type(), text: message.text() }));
  page.on('requestfailed', (request) => probe.failures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(() => {
    if (window !== window.top || localStorage.getItem('captcha-fixture')) return;
    localStorage.setItem('captcha-fixture', '1');
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke_server_url', 'http://library.test');
    localStorage.setItem('moke-server-storage', JSON.stringify({ state: {
      serverUrl: 'http://library.test', serverTitle: 'Fixture library', offlineMode: false,
      isConnected: true, user: null, hasHydrated: true,
    }, version: 0 }));
  });
  await page.route('https://static.geetest.com/v4/gt4.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: `
      window.initGeetest4 = (_, ready) => {
        let success; let value = 'wrong';
        const button = document.createElement('button'); button.textContent = 'SDK challenge';
        document.body.appendChild(button);
        const gt = { appendTo: () => gt, onSuccess: fn => { success = fn; return gt; }, onError: () => gt,
          showCaptcha: () => {}, getValidate: () => ({ lot_number: value, captcha_output: 'fixture', pass_token: 'fixture', gen_time: 'fixture' }) };
        button.onclick = () => { success(); value = 'correct'; }; ready(gt);
      };`,
  }));
  await page.route('http://library.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json = { err: 'ok', books: [], total: 0, count: 0 };
    if (path === '/api/captcha/config') {
      const plan = probe.configPlans.shift();
      if (plan?.gate) await plan.gate.promise;
      json = plan?.json || { err: 'ok', config: provider === 'image' ? { provider }
        : provider === 'geetest' ? { provider, captchaId: 'fixture-id' }
          : { provider, html: `<button onclick="window.__moke_captcha_success({provider:'webcode',answer:this.dataset.answer||'wrong'});this.dataset.answer='correct'">Solve fixture</button>` } };
    } else if (path === '/api/captcha/image') {
      json = { err: 'ok', image: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDQiPjx0ZXh0IHg9IjEwIiB5PSIzMCI+MTIzNDwvdGV4dD48L3N2Zz4=' };
    } else if (request.method() === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(request.postData() || ''));
      probe.posts.push({ path, body });
      const plan = probe.plans.shift();
      if (plan?.gate) await plan.gate.promise;
      if (plan?.abort) return route.abort('failed');
      const supplied = body.captcha_code || body.answer || body.lot_number;
      const correct = [body.captcha_code, body.answer, body.lot_number].includes('correct');
      json = plan?.json || (ordinary || correct ? { err: 'ok' } : supplied
        ? { err: 'captcha.invalid', msg: 'Fixture rejected challenge' }
        : { err: 'captcha.required', msg: 'Fixture challenge required' });
      if (json.err === 'ok' && path === '/api/user/sign_in') probe.loggedIn = true;
    } else if (path === '/api/user/info') {
      probe.infos += 1;
      const plan = probe.infoPlans.shift();
      if (plan?.gate) await plan.gate.promise;
      if (plan?.abort) return route.abort('failed');
      json = { err: 'ok', user: { is_login: probe.loggedIn, id: 42, username: 'fixture-reader', nickname: 'Fixture reader' }, sys: { title: 'Fixture library' } };
    } else if (path === '/api/welcome') json = { err: 'not_required' };
    await route.fulfill({ json, headers: { 'access-control-allow-origin': authBase, 'access-control-allow-credentials': 'true' } });
  });
  return probe;
}

export async function fillAuthPage(page, path) {
  if (path === 'access') await page.getByPlaceholder('请输入访问码').fill('fixture-access');
  else {
    await page.getByPlaceholder('请输入用户名').fill('fixture-reader');
    await page.getByPlaceholder('请输入密码').fill('fixture-password');
  }
  return page.getByRole('button', { name: path === 'access' ? '确认' : '登录', exact: true });
}

export async function openAuthChallenge(page, path) {
  await page.goto(`${authBase}/${path}`);
  const trigger = await fillAuthPage(page, path);
  await trigger.click();
  return page.getByRole('dialog', { name: '安全验证' });
}
