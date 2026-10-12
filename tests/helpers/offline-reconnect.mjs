import { expect } from '@playwright/test';
import { installLibraryLayoutMock, LAYOUT_OFFLINE_BOOK } from './library-layout.mjs';
import { clickAppLink } from './offline-mode-fixture.mjs';

export const RECONNECT_SERVER = 'https://previous.books.test';
export const OTHER_RECONNECT_SERVER = 'https://other.books.test';

export async function openReconnectSettings(page) {
  // The online mobile tab bar reaches settings through the account page;
  // offline tabs and the desktop sidebar expose settings directly.
  const direct = page.locator('a[href="/settings"]:visible').first();
  if (await direct.count()) await direct.click();
  else {
    await clickAppLink(page, '/user');
    await page.getByRole('link', { name: '前往设置', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/settings$/);
}

export async function installOfflineReconnectMock(page, { serverUrl = RECONNECT_SERVER, cachedUser = true, fallback = '' } = {}) {
  await installLibraryLayoutMock(page, { continueReading:false,nativeBooks:[{...LAYOUT_OFFLINE_BOOK,serverUrl:RECONNECT_SERVER}] });
  await page.addInitScript(({ serverUrl, cachedUser, fallback }) => {
    // Persist only server metadata. Every runtime session below is established
    // through the real connection UI before entering the offline checkpoint.
    localStorage.setItem('moke-server-storage',JSON.stringify({version:1,state:{savedServers:[
      {id:'previous',url:'https://previous.books.test',title:'恢复测试书库',addedAt:''},
      {id:'other',url:'https://other.books.test',title:'恢复测试书库',addedAt:''},
    ]}}));
    if (fallback) localStorage.setItem('moke_server_url',fallback);
    else localStorage.removeItem('moke_server_url');
    window.__MOKE_RECONNECT_FIXTURE__={mode:'success',requests:[],bootstrap:true,cachedUser,serverUrl};
    const original=window.__TAURI_INTERNALS__.invoke, requests=new Map(),bodies=new Map();
    let nextId=5000;
    window.__TAURI_INTERNALS__.invoke=async (command,args={}) => {
      const fixture=window.__MOKE_RECONNECT_FIXTURE__;
      if (command==='plugin:window|get_all_windows') return ['main'];
      if (command==='plugin:fs|exists') return false;
      if (command==='plugin:http|fetch') {
        const id=nextId++;requests.set(id,args.clientConfig.url);fixture.requests.push(args.clientConfig.url);return id;
      }
      if (command==='plugin:http|fetch_send') {
        const url=requests.get(args.rid),path=new URL(url).pathname;
        if (fixture.mode==='hang') await new Promise(resolve => {fixture.release=resolve;});
        if (fixture.mode==='network') throw new Error('Fixture server unreachable');
        const guest=fixture.mode==='expired' || (fixture.bootstrap && !fixture.cachedUser);
        const info=guest ? {err:'user.need_login',user:{is_login:false}} : {
          err:'ok',user:{id:1,username:'fixture-reader',name:'fixture-reader',is_login:true},sys:{title:'恢复测试书库',version:'3.15.0'},
        };
        const payload=path==='/api/user/info' ? info : path==='/api/welcome' ? {err:fixture.mode==='access'?'ok':'free'}
          : ['/api/shelf','/api/library'].includes(path) ? {err:'ok',books:[],total:0}
          : path==='/api/network/sources' ? {err:'ok',items:[]} : {err:'ok'};
        const id=nextId++;bodies.set(id,JSON.stringify(payload));
        return {status:200,statusText:'OK',url,rid:id,headers:[['content-type','application/json']]};
      }
      if (command==='plugin:http|fetch_read_body') {
        const body=bodies.get(args.rid);bodies.delete(args.rid);return body ? [...new TextEncoder().encode(body),0] : [1];
      }
      if (command.startsWith('plugin:http|fetch_cancel')) return null;
      return original(command,args);
    };
  },{serverUrl,cachedUser,fallback});
}

export async function startOfflineReconnect(page, baseUrl, { offlineMode=true,serverUrl=RECONNECT_SERVER,mode='success',cachedUser=true,fallback='' } = {}) {
  await installOfflineReconnectMock(page,{serverUrl,cachedUser,fallback});
  await page.goto(`${baseUrl}/welcome`);
  if (serverUrl) {
    await page.locator('li button').filter({hasText:serverUrl}).click();
    await expect(page).toHaveURL(/\/shelf$/);
    if (cachedUser) await expect(page.locator('aside').getByText('fixture-reader',{exact:true})).toHaveCount(1);
    if (offlineMode) {
      await openReconnectSettings(page);
      await page.getByRole('button',{name:'进入离线模式',exact:true}).click();
      await expect(page).toHaveURL(/\/shelf$/);
    }
  } else if (offlineMode) {
    await page.getByRole('button',{name:'进入离线模式',exact:true}).click();
    await expect(page).toHaveURL(/\/shelf$/);
  }
  await page.evaluate(mode => {
    Object.assign(window.__MOKE_RECONNECT_FIXTURE__,{mode,bootstrap:false,requests:[]});
  },mode);
}
