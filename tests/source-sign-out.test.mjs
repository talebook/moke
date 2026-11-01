import test from 'node:test';
import assert from 'node:assert/strict';
import { signOutSource } from '../src/lib/source-sign-out.ts';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const A = { serverUrl: 'https://a.example/team/books', sessionRevision: 4 };

test('explicit sign-out consumes the response body before clearing its matching local session, including non-2xx', async () => {
  for (const status of [200, 503]) {
    const entered = deferred();
    const finish = deferred();
    let cleared = false;
    const operation = signOutSource(A, async (url, init) => {
      assert.equal(url, `${A.serverUrl}/api/user/sign_out`);
      assert.equal(init.credentials, 'include');
      return new Response(new ReadableStream({ async pull(controller) { entered.resolve(); await finish.promise; controller.close(); } }), { status });
    }, () => A, () => { cleared = true; });
    await entered.promise;
    assert.equal(cleared, false);
    finish.resolve();
    assert.equal(await operation, true);
    assert.equal(cleared, true);
  }
});

test('late A logout never clears B or a new login epoch at the same complete base', async () => {
  for (const replacement of [{ serverUrl: 'https://b.example/other/books', sessionRevision: 5 }, { ...A, sessionRevision: 5 }]) {
    const response = deferred();
    let current = A;
    let cleared = 0;
    const operation = signOutSource(A, () => response.promise, () => current, () => { cleared++; });
    current = replacement;
    response.resolve(new Response('{"err":"ok"}'));
    assert.equal(await operation, false);
    assert.equal(cleared, 0);
    assert.equal(current, replacement);
  }
});

test('a failed remote sign-out still permits the explicit matching local logout', async () => {
  let cleared = 0;
  assert.equal(await signOutSource(A, async () => { throw new Error('offline'); }, () => A, () => { cleared++; }), true);
  assert.equal(cleared, 1);
});
