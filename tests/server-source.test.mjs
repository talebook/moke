import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
const { request, downloadBookBlob, streamBookDownload } = await import('../src/lib/api.ts');
const { useDebugLogStore } = await import('../src/lib/debug-log.ts');
import { useServerStore } from '../src/lib/store/server.ts';
const { fetchReadingProgress, saveReadingProgress } = await import('../src/lib/reading-progress.ts');
import { clearReadStateCache, filterReadingStateBooks } from '../src/lib/reading-state.ts';

const progress = { schema:'moke.readest.progress.v1',reader:'readest',moke_book_id:'42',location:'A-location',updated_at:'2026-10-04T00:00:00Z' };

test('an aborted request with a custom timeout reason remains cancellation diagnostics', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new Error('连接超时，请重试');
  controller.abort(reason);
  globalThis.fetch = async () => { throw reason; };
  useDebugLogStore.getState().clear();
  try {
    await assert.rejects(request('http://a.test/api/user/info', { signal: controller.signal }), error => error === reason);
    const logs = useDebugLogStore.getState().logs.filter(log => log.tag === 'request');
    assert.equal(logs.some(log => log.level === 'error'), false);
    assert.equal(logs.some(log => log.level === 'info' && log.message.includes('已取消')), true);
  } finally { globalThis.fetch = original; }
});

test('download blob and streaming retries use their explicit A origin while B is active', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return new Response('A-content'); };
  useServerStore.setState({serverUrl:'http://b.test'});
  try {
    const blob = await downloadBookBlob('42','pdf',{serverUrl:'http://a.test'});
    assert.equal(await blob.text(), 'A-content');
    for (let retry = 0; retry < 2; retry++) {
      const chunks = [];
      await streamBookDownload('42','pdf',{serverUrl:'http://a.test',write:async (chunk)=>chunks.push(chunk)});
      assert.equal(new TextDecoder().decode(chunks[0]), 'A-content');
    }
    assert.deepEqual(requests, Array(3).fill('http://a.test/api/book/42.pdf'));
  } finally { globalThis.fetch = original; useServerStore.getState().disconnect(); }
});

test('progress load/save keep A origin; unsupported A response cannot change B capabilities', async () => {
  const original = globalThis.fetch;
  const requests = [];
  let supported = true;
  globalThis.fetch = async (url, init) => {
    requests.push([String(url),init.method || 'GET',init.body]);
    return new Response(JSON.stringify(supported ? {err:'ok',progress} : {err:'page.not_found'}),{status:supported ? 200:404,headers:{'content-type':'application/json'}});
  };
  useServerStore.setState({serverUrl:'http://b.test',capabilities:{readingProgressApi:true,checkedAt:123}});
  try {
    assert.deepEqual(await fetchReadingProgress('42', undefined, 'http://a.test'), progress);
    await saveReadingProgress('42', progress, 'http://a.test');
    supported = false;
    await saveReadingProgress('42', progress, 'http://a.test');
    assert.equal(useServerStore.getState().capabilities.readingProgressApi,true);
    assert.equal(useServerStore.getState().capabilities.checkedAt,123);
    assert.deepEqual(requests.map(([url])=>url),Array(3).fill('http://a.test/api/book/42/progress'));
    assert.equal(JSON.parse(requests[1][2]).progress.location,'A-location');
  } finally { globalThis.fetch = original; useServerStore.getState().disconnect(); }
});

test('clearing auth cache prevents older in-flight read-state results from re-populating it', async () => {
  clearReadStateCache();
  let finish;
  const old = filterReadingStateBooks(()=>new Promise(resolve=>{finish=resolve;}),'http://a.test',[{id:'42'}]);
  clearReadStateCache();
  finish(new Response(JSON.stringify({err:'ok',read_state:1})));
  await old;
  let calls=0;
  const current=await filterReadingStateBooks(async()=>{calls++;return new Response(JSON.stringify({err:'ok',read_state:2}));},'http://a.test',[{id:'42'}]);
  assert.equal(calls,1);
  assert.equal(current.finished.length,1);
});
