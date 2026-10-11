import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier !== '@tauri-apps/api/core') return next(specifier, context);
  return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export const invoke = (...args) => globalThis.__mokeNavigationInvoke(...args);') };
} });
const { navigateFullDocument } = await import('../src/lib/moke-reader.ts');

async function fixture(run) {
  const previousPlatform=process.env.NEXT_PUBLIC_APP_PLATFORM, previousWindow=globalThis.window;
  const calls=[];
  process.env.NEXT_PUBLIC_APP_PLATFORM='tauri';
  globalThis.window={location:{assign:href=>calls.push(['assign',href])}};
  globalThis.__mokeNavigationInvoke=async(...args)=>calls.push(['invoke',...args]);
  try { await run(calls); } finally {
    if(previousPlatform===undefined)delete process.env.NEXT_PUBLIC_APP_PLATFORM;else process.env.NEXT_PUBLIC_APP_PLATFORM=previousPlatform;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
    delete globalThis.__mokeNavigationInvoke;
  }
}

test('offline handoff preparation precedes document replacement on iOS, Android and OHOS',()=>fixture(async calls=>{
  for(const platform of ['ios','android','ohos']) {
    calls.length=0;
    await navigateFullDocument('/library',()=>assert.fail('unexpected router fallback'),platform,()=>calls.push(['prepare']));
    assert.deepEqual(calls,platform==='ios'?[['prepare'],['assign','/library']]:[['prepare'],['invoke','moke_navigate',{path:'/library'}]]);
  }
}));

test('router navigation does not create a stale document receipt',()=>fixture(async calls=>{
  for(const platform of ['windows','linux','web']) {
    calls.length=0;
    if(platform==='web')process.env.NEXT_PUBLIC_APP_PLATFORM='web';
    await navigateFullDocument('/library',href=>calls.push(['router',href]),platform,()=>assert.fail('router must not prepare a receipt'));
    assert.deepEqual(calls,[['router','/library']]);
  }
}));

test('denied handoff preparation stops all native and fallback navigation',()=>fixture(async calls=>{
  for(const platform of ['ios','android','ohos']) {
    await assert.rejects(navigateFullDocument('/library',()=>assert.fail('cannot fallback after denied receipt'),platform,()=>{throw new Error('denied');}),/denied/);
    assert.deepEqual(calls,[]);
  }
}));
