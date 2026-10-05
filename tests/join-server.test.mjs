import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJoinServerAddress, prepareServerJoin, readJoinWelcomeResult } from '../src/lib/join-server.ts';

test('joining accepts LAN addresses, HTTPS and IPv6 without changing their origin', () => {
  for (const [input, origin] of [
    [' 192.168.1.100:8080 ', 'http://192.168.1.100:8080'],
    ['HTTPS://Books.Example.com/', 'https://books.example.com'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ]) {
    const parsed = parseJoinServerAddress(input);
    assert.equal(parsed.origin, origin);
    assert.equal(`${parsed.protocol}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`, origin);
  }
});

test('joining rejects empty, unsafe or silently truncated server addresses', () => {
  for (const input of ['', ' ', 'not a url', 'ftp://books.example', 'javascript:alert(1)',
    'https://user:password@books.example', 'https://books.example/library',
    'https://books.example/?token=secret', 'https://books.example/#frag']) {
    assert.throws(() => parseJoinServerAddress(input));
  }
});

test('only documented welcome responses allow joining', () => {
  assert.deepEqual(readJoinWelcomeResult({err:'ok', welcome:'欢迎'}), {err:'ok', msg:'欢迎', needsAccessCode:true});
  assert.deepEqual(readJoinWelcomeResult({err:'free'}), {err:'ok', msg:undefined, needsAccessCode:false});
  for (const data of [{err:'permission.denied'}, {err:'not_installed'}, {}, {msg:'bad response'}, null, 'ok', {err:42, msg:{}}]) {
    assert.notEqual(readJoinWelcomeResult(data).err, 'ok');
  }
});

test('both checks finish before a join is prepared and receive the cancellation signal', async () => {
  const controller = new AbortController();
  const calls = [];
  const joined = await prepareServerJoin('books.example:8080', {
    validate: async (url, signal) => { calls.push('validate'); assert.equal(signal, controller.signal); assert.equal(url, 'http://books.example:8080'); return {err:'ok'}; },
    welcome: async () => { calls.push('welcome'); return {err:'ok', needsAccessCode:true}; },
  }, controller.signal);
  assert.deepEqual(calls, ['validate', 'welcome']);
  assert.equal(joined.needsAccessCode, true);
});

test('failed checks never prepare a server and can be retried', async () => {
  let welcomeCalls = 0;
  const checks = {
    validate: async () => ({err:'network.error', msg:'网络失败'}),
    welcome: async () => { welcomeCalls++; return {err:'server.failed', msg:'检查失败', needsAccessCode:false}; },
  };
  await assert.rejects(prepareServerJoin('books.example', checks, new AbortController().signal), /网络失败/);
  assert.equal(welcomeCalls, 0);
  checks.validate = async () => ({err:'ok'});
  await assert.rejects(prepareServerJoin('books.example', checks, new AbortController().signal), /检查失败/);
  checks.welcome = async () => ({err:'ok', needsAccessCode:false});
  assert.equal((await prepareServerJoin('books.example', checks, new AbortController().signal)).needsAccessCode, false);
});

for (const stage of ['validate', 'welcome']) {
  test(`cancelling during ${stage} ignores late success even if transport cannot abort`, async () => {
    const controller = new AbortController();
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const checks = {
      validate: async () => ({err:'ok'}),
      welcome: async () => ({err:'ok', needsAccessCode:false}),
      [stage]: async () => pending,
    };
    const joining = prepareServerJoin('books.example', checks, controller.signal);
    await new Promise(r => setImmediate(r));
    controller.abort();
    resolve({err:'ok', needsAccessCode:false});
    await assert.rejects(joining, {name:'AbortError'});
  });
}
