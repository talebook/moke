import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderProgressQueue } from '../src/lib/reader-progress-queue.ts';
import { createReaderSourceBoundary } from '../src/lib/reader-source.ts';

const a = { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 };
const b = { serverUrl: 'https://b.test', bookId: '42', sessionId: 2 };
const progress = location => ({ moke_book_id: '42', location });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function watchUnhandled(context) {
  const errors = [];
  const listener = error => { errors.push(error); };
  process.on('unhandledRejection', listener);
  context.after(() => process.off('unhandledRejection', listener));
  return errors;
}

for (const failure of ['reject', 'throw']) {
  test(`progress ${failure} is best-effort, drains once and reports only its immutable source`, async context => {
    const unhandled = watchUnhandled(context);
    const attempts = [], failures = [];
    const queue = createReaderProgressQueue((source, value) => {
      attempts.push([source.serverUrl, value.location]);
      const error = new Error('token=fixture-secret; internal response body');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    }, 10000, source => { failures.push(source); });
    const source = { ...a };
    queue.schedule(source, progress('first'));
    source.serverUrl = b.serverUrl;
    await queue.flush();
    await queue.flush();
    assert.deepEqual(attempts, [[a.serverUrl, 'first']]);
    assert.deepEqual(failures, [a]);
    assert.doesNotMatch(JSON.stringify(failures), /fixture-secret|internal response/);
    queue.schedule(b, progress('second'));
    await queue.flush();
    assert.deepEqual(attempts, [[a.serverUrl, 'first'], [b.serverUrl, 'second']]);
    await nextTurn();
    assert.deepEqual(unhandled, []);
  });
}

test('timer-dispatched synchronous saves and a throwing diagnostic cannot reject flush or escape asynchronously', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = watchUnhandled(context);
  let attempts = 0, diagnostics = 0;
  const queue = createReaderProgressQueue(() => { attempts++; throw new Error('save failed'); }, 10,
    () => { diagnostics++; throw new Error('diagnostic failed'); });
  queue.schedule(a, progress('timer'));
  context.mock.timers.tick(10);
  await queue.flush();
  await queue.flush();
  await nextTurn();
  assert.equal(attempts, 1);
  assert.equal(diagnostics, 1);
  assert.deepEqual(unhandled, []);
});

test('flush waits for an in-flight rejection and drains progress queued while that save was pending', async context => {
  const unhandled = watchUnhandled(context);
  const attempts = [], failures = [];
  let rejectSave;
  const stalled = new Promise((_, reject) => { rejectSave = reject; });
  const queue = createReaderProgressQueue((source, value) => {
    attempts.push([source.serverUrl, value.location]);
    return value.location === 'first' ? stalled : Promise.resolve();
  }, 10000, source => { failures.push(source); });
  queue.schedule(a, progress('first'));
  let complete = false;
  const flushing = queue.flush().then(() => { complete = true; });
  await nextTurn();
  assert.equal(complete, false);
  queue.schedule(b, progress('second'));
  rejectSave(new Error('async persistence failure'));
  await flushing;
  await queue.flush();
  assert.deepEqual(attempts, [[a.serverUrl, 'first'], [b.serverUrl, 'second']]);
  assert.deepEqual(failures, [a]);
  await nextTurn();
  assert.deepEqual(unhandled, []);
});

for (const failure of ['reject', 'throw']) {
  test(`a ${failure}ing best-effort progress save permits reserved session changes and the next Reader open`, async context => {
    const unhandled = watchUnhandled(context);
    const state = { labels: [], sessionId: 1, opens: 0 };
    const boundary = createReaderSourceBoundary({
      getWindowLabels: async () => state.labels,
      getContext: async () => ({ sessionId: state.sessionId, candidate: null }),
      open: async () => { state.opens++; state.labels = ['reader-b']; },
      wait: async () => assert.fail('the new window should be observable'), now: () => 0,
    });
    const failures = [];
    const queue = createReaderProgressQueue(() => {
      if (failure === 'throw') throw new Error('sync persistence failure');
      return Promise.reject(new Error('async persistence failure'));
    }, 10000, source => { failures.push(source); });
    const unregister = boundary.registerReaderProgressFlush(() => queue.flush());
    context.after(unregister);
    queue.schedule(a, progress('before switch'));
    await boundary.withClosedReaderSession(async () => { state.sessionId = 2; });
    assert.equal(state.sessionId, 2);
    queue.schedule(a, progress('late old session progress'));
    await boundary.openReaderFromSource(b, {});
    assert.equal(state.opens, 1);
    assert.deepEqual(boundary.sourceForReaderEvent('reader-b', '42'), b);
    assert.deepEqual(failures, [a, a]);
    await nextTurn();
    assert.deepEqual(unhandled, []);
  });
}
