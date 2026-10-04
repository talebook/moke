/** Web-only network fixture; list persistence is always the application's real storage. */
export async function installServerListFixture(page) {
  const origins = ['https://a.example.test', 'http://b.example.test:8080'];
  const servers = new Map(origins.map((origin, index) => [origin, {name:index ? 'B' : 'A', invited:!index, loggedIn:!index, fault:null}]));
  const requests = [];
  const waiting = [];
  await page.route(/https?:\/\/[ab]\.example\.test(?::8080)?\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const server = servers.get(url.origin);
    requests.push({origin:url.origin,path:url.pathname,method:request.method()});
    if (!server) return route.abort('failed');
    if (server.fault === 'offline') return route.abort('failed');
    if (server.fault === 'delay') await new Promise(resolve => waiting.push(resolve));
    if (server.fault === 'html') return route.fulfill({contentType:'text/html',body:'<h1>not Talebook</h1>'}).catch(()=>{});
    if (server.fault === 'busy') return route.fulfill({status:503,json:{err:'server.busy',msg:'模拟繁忙'}}).catch(()=>{});
    const book={id:'42',title:`${server.name} 同编号藏书`,authors:[{name:`${server.name} 作者`}],publisher:`${server.name} 出版社`,comments:`${server.name} 简介`,files:[{format:'pdf',size:100}],state:{wants:false,download:0,read_state:1}};
    let data;
    if (url.pathname === '/api/welcome') {
      if (request.method()==='POST') {server.invited=true;data={err:'ok'};}
      else data={err:server.invited?'free':'ok'};
    } else if (url.pathname === '/api/user/info') data={err:'ok',sys:{title:`${server.name} 测试书库`,version:'3.15.0'},user:{id:server.name==='A'?101:202,username:`reader-${server.name}`,nickname:`${server.name} 测试读者`,is_login:server.loggedIn,permission:'admin'}};
    else if (url.pathname === '/api/user/sign_in') {server.loggedIn=true;data={err:'ok'};}
    else if (url.pathname === '/api/user/sign_out') {server.loggedIn=false;data={err:'ok'};}
    else if (url.pathname === '/api/book/42') data={err:'ok',book};
    else if (['/api/shelf','/api/library','/api/search'].includes(url.pathname)) data={err:'ok',books:[book],total:1,total_count:1,navs:[]};
    else if (url.pathname === '/api/book/42/readstate') data={err:'ok',read_state:1};
    else if (url.pathname === '/api/book/42.pdf') return route.fulfill({contentType:'application/pdf',body:'%PDF-fixture'});
    else if (url.pathname === '/api/book/42/progress') data={err:'ok',progress:{schema:'moke.readest.progress.v1',reader:'readest',moke_book_id:'42',location:`${server.name}-location`,updated_at:'2026-10-04T00:00:00Z'}};
    else data={err:'page.not_found'};
    return route.fulfill({json:data}).catch(()=>{});
  });
  const fixture={origins,requests,servers,release:()=>{for(const resolve of waiting.splice(0)) resolve();}};
  page.mokeServerFixture=fixture;
  return fixture;
}
