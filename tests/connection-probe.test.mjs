import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSavedServer } from '../src/lib/connection-probe.ts';

const BASE = 'https://books.example:8443/a';
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function transport(responses) {
  const calls = [];
  return {
    calls,
    async request(url, init) {
      calls.push({ url, init });
      const response = responses.shift();
      assert.ok(response, `unexpected additional request: ${url}`);
      return response;
    },
  };
}

test('candidate probe preserves /a in both GETs and fixes credentials, signal and zero-redirect options', async () => {
  const controller = new AbortController();
  const fixture = transport([json({ err: 'ok' }), json({ err: 'free' })]);
  assert.deepEqual(await probeSavedServer(fixture.request, BASE, controller.signal), { needsAccessCode: false });
  assert.deepEqual(fixture.calls.map(({ url }) => url), [`${BASE}/api/user/info`, `${BASE}/api/welcome`]);
  for (const { init } of fixture.calls) {
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.credentials, 'include');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.redirect, 'error');
    assert.equal(init.maxRedirections, 0);
    assert.equal(init.body, undefined);
  }
});

test('all supported info states continue to the independent welcome check', async () => {
  for (const err of ['ok', 'not_invited', 'user.need_login', 'not_installed']) {
    const fixture = transport([json({ err }), json({ err: 'free' })]);
    assert.deepEqual(await probeSavedServer(fixture.request, BASE, new AbortController().signal), { needsAccessCode: false }, err);
    assert.equal(fixture.calls.length, 2, err);
  }
});

test('only welcome free is code-free; ok and not_invited require access code', async () => {
  for (const [err, needsAccessCode] of [['free', false], ['ok', true], ['not_invited', true]]) {
    const fixture = transport([json({ err: 'ok' }), json({ err })]);
    assert.deepEqual(await probeSavedServer(fixture.request, BASE, new AbortController().signal), { needsAccessCode }, err);
  }
});

test('unknown or missing info err refuses the candidate before checking welcome', async () => {
  for (const value of [{ err: 'unknown' }, { err: 'free' }, {}, { err: 1 }, { err: null }]) {
    const fixture = transport([json(value)]);
    await assert.rejects(probeSavedServer(fixture.request, BASE, new AbortController().signal), { message: 'server.invalid_response' });
    assert.equal(fixture.calls.length, 1);
  }
});

test('unknown or missing welcome err cannot turn a failed access check into code-free success', async () => {
  for (const value of [{ err: 'unknown' }, { err: 'user.need_login' }, {}, { err: 1 }, { err: null }]) {
    const fixture = transport([json({ err: 'ok' }), json(value)]);
    await assert.rejects(probeSavedServer(fixture.request, BASE, new AbortController().signal), { message: 'server.access_check_failed' });
    assert.equal(fixture.calls.length, 2);
  }
});

test('HTTP failure rejects even when its info or welcome envelope contains a supported err', async () => {
  for (const status of [301, 401, 403, 404, 500]) {
    const badInfo = transport([json({ err: 'not_invited' }, status)]);
    await assert.rejects(probeSavedServer(badInfo.request, BASE, new AbortController().signal), { message: 'server.invalid_response' });
    assert.equal(badInfo.calls.length, 1);
    const badWelcome = transport([json({ err: 'ok' }), json({ err: 'free' }, status)]);
    await assert.rejects(probeSavedServer(badWelcome.request, BASE, new AbortController().signal), { message: 'server.access_check_failed' });
    assert.equal(badWelcome.calls.length, 2);
  }
});

test('HTML, empty and malformed JSON are refused at either endpoint', async () => {
  for (const body of ['<html>Sign in</html>', '', '{broken-json']) {
    const badInfo = transport([new Response(body, { headers: { 'Content-Type': 'text/html' } })]);
    await assert.rejects(probeSavedServer(badInfo.request, BASE, new AbortController().signal));
    assert.equal(badInfo.calls.length, 1);
    const badWelcome = transport([json({ err: 'ok' }), new Response(body)]);
    await assert.rejects(probeSavedServer(badWelcome.request, BASE, new AbortController().signal));
    assert.equal(badWelcome.calls.length, 2);
  }
});

test('non-object JSON cannot accidentally pass the supported envelope contract', async () => {
  for (const body of [null, [], 'ok', true, 42]) {
    const fixture = transport([json(body)]);
    await assert.rejects(probeSavedServer(fixture.request, BASE, new AbortController().signal));
    const welcome = transport([json({ err: 'ok' }), json(body)]);
    await assert.rejects(probeSavedServer(welcome.request, BASE, new AbortController().signal));
  }
});

test('network and AbortError failures retain their identity and are not retried', async () => {
  for (const failure of [new Error('offline'), new DOMException('cancelled', 'AbortError')]) {
    let calls = 0;
    const signal = new AbortController().signal;
    await assert.rejects(probeSavedServer(async (_url, init) => {
      calls++;
      assert.equal(init.signal, signal);
      throw failure;
    }, BASE, signal), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test('the same aborted signal reaches the welcome transport without swallowing its AbortError', async () => {
  const controller = new AbortController();
  const failure = new DOMException('cancelled after info', 'AbortError');
  let calls = 0;
  await assert.rejects(probeSavedServer(async (_url, init) => {
    calls++;
    assert.equal(init.signal, controller.signal);
    if (calls === 1) { controller.abort(); return json({ err: 'ok' }); }
    assert.equal(init.signal.aborted, true);
    throw failure;
  }, BASE, controller.signal), (error) => error === failure);
  assert.equal(calls, 2);
});
