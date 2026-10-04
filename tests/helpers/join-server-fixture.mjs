export async function installJoinServerFixture(page, options = {}) {
  const state = { mode: 'free', delay: 0, loggedIn: false, accessGranted: false, requests: [], ...options };
  const book = {
    id: '42', title: '加入服务器回归示例', authors: ['虚构作者'],
    files: [{format:'epub', size:440912}], state: {wants:false, download:0},
    publisher: '测试出版社', comments: '虚构测试书籍',
  };
  await page.addInitScript(({savedServer, offlineMode}) => {
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    if (savedServer || offlineMode) localStorage.setItem('moke-server-storage', JSON.stringify({
      state: {serverUrl:savedServer || '', offlineMode: Boolean(offlineMode), isConnected: Boolean(savedServer), user:null}, version:0,
    }));
  }, {savedServer:options.savedServer, offlineMode:options.offlineMode});
  await page.route(/^http:\/\/(join|saved)\.test\//, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const mode = state.mode;
    state.requests.push({path, method:request.method()});
    if (path === '/api/user/info' && state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (mode === 'network') { await route.abort('failed'); return; }
    if (mode === 'invalid') { await route.fulfill({status:200, body:'<html>not Talebook</html>'}); return; }
    let data = {err:'ok'};
    if (path === '/api/user/info') data = {
      err: state.loggedIn ? 'ok' : 'user.need_login',
      sys: {title:'虚构测试书库', version:'3.15.0'},
      user: state.loggedIn ? {id:1, username:'reader', nickname:'测试读者', is_login:true, permission:'read'} : undefined,
    };
    else if (path === '/api/welcome') {
      if (request.method() === 'POST') {
        state.accessGranted = true;
        data = {err:'ok'};
      } else data = mode === 'error' ? {err:'server.failed', msg:'模拟访问码检查失败'}
        : mode === 'access' && !state.accessGranted ? {err:'ok', welcome:'测试私有书库'} : {err:'free'};
    } else if (path === '/api/user/sign_in') state.loggedIn = true;
    else if (path === '/api/book/nav') data = {err:'ok', navs:[]};
    else if (path === '/api/library') data = {err:'ok', books:[book], total:1};
    else if (path === '/api/shelf') data = {err:'ok', books:[], total:0};
    else if (path === '/api/book/42') data = {err:'ok', book};
    else if (path === '/api/network/sources') data = {err:'ok', sources:[]};
    else if (path === '/api/book/42/progress') data = {err:'ok', progress:null};
    else if (path === '/api/book/42/readstate') data = {err:'ok', state:{}};
    await route.fulfill({json:data});
  });
  return state;
}
