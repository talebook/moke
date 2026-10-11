import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderSourceBoundary } from '../src/lib/reader-source.ts';
import { createReaderProgressQueue, READER_PROGRESS_TIMEOUT_MS } from '../src/lib/reader-progress-queue.ts';

const a = { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 };
const b = { serverUrl: 'https://b.test', bookId: '42', sessionId: 2 };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => { warnings.push(args); });
  const unhandled = [];
  const listener = error => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  context.after(() => process.off('unhandledRejection', listener));
  const state = { labels: [], sessionId: 1, candidate: null, opens: 0 };
  const boundary = createReaderSourceBoundary({
    getWindowLabels: async () => [...state.labels],
    getContext: async () => ({ sessionId: state.sessionId, candidate: state.candidate }),
    open: async () => { state.opens++; state.labels = [`reader-${state.opens}`]; },
    wait: async () => assert.fail('the window should be observable'), now: () => 0,
  });
  return { state, boundary, warnings, unhandled };
}

for (const path of ['session change', 'Reader open']) {
  for (const late of ['resolve', 'reject']) {
    test(`${path} releases a hung flush at its deadline and handles a late ${late} without repeating the wait`, async context => {
      const { state, boundary, warnings, unhandled } = fixture(context);
      const gate = deferred(), entered = deferred();
      let attempts = 0, complete = false;
      boundary.registerReaderProgressFlush(() => {
        attempts++;
        entered.resolve();
        return attempts === 1 ? gate.promise : Promise.resolve();
      });
      const operation = path === 'session change'
        ? boundary.withClosedReaderSession(async () => { state.sessionId = 2; })
        : boundary.openReaderFromSource(a, {});
      const completion = operation.then(() => { complete = true; });
      await entered.promise;
      await assert.rejects(boundary.withClosedReaderSession(async () => {}), /状态正在变更/);
      context.mock.timers.tick(READER_PROGRESS_TIMEOUT_MS - 1);
      await nextTurn();
      assert.equal(complete, false);
      context.mock.timers.tick(1);
      await completion;
      assert.equal(complete, true);
      assert.equal(state.sessionId, path === 'session change' ? 2 : 1);
      assert.equal(state.opens, path === 'Reader open' ? 1 : 0);
      if (path === 'Reader open') {
        await assert.rejects(boundary.requireClosedReaders(), /请先关闭/);
        assert.deepEqual(boundary.sourceForReaderEvent('reader-1', '42'), a);
        state.labels = [];
      }
      // The exact hung invocation has already spent its wait budget.
      await boundary.requireClosedReaders();
      assert.equal(attempts, 1);
      assert.deepEqual(warnings.map(args => args[1]), [{ reason: 'timeout' }]);
      if (late === 'reject') gate.reject(new Error('token=fixture-secret; internal response'));
      else gate.resolve();
      await nextTurn();
      await boundary.requireClosedReaders();
      assert.equal(attempts, 2, 'a recovered registrant can flush new progress');
      assert.equal(warnings.length, 1, 'late completion must not report the same failure again');
      assert.doesNotMatch(JSON.stringify(warnings), /fixture-secret|internal response/);
      assert.deepEqual(unhandled, []);
    });
  }
}

for (const changed of ['session', 'candidate']) {
  test(`Reader dispatch still rejects a changed ${changed} after the flush deadline`, async context => {
    const { state, boundary, unhandled } = fixture(context);
    const gate = deferred(), entered = deferred();
    const remove = boundary.registerReaderProgressFlush(() => { entered.resolve(); return gate.promise; });
    const opening = boundary.openReaderFromSource(a, {});
    // Attach the rejection expectation before advancing the deadline.
    const rejected = assert.rejects(opening, { code: 'reader.context_changed' });
    await entered.promise;
    if (changed === 'session') state.sessionId = 2;
    else state.candidate = { serverUrl: b.serverUrl };
    context.mock.timers.tick(READER_PROGRESS_TIMEOUT_MS);
    await rejected;
    assert.equal(state.opens, 0);
    remove();
    gate.reject(new Error('late progress rejection'));
    await nextTurn();
    await boundary.requireClosedReaders();
    assert.deepEqual(unhandled, []);
  });
}

test('queue times out and aborts the original request once, then flushes new-source progress immediately', async context => {
  const { boundary, state, unhandled } = fixture(context);
  const gate = deferred(), entered = deferred();
  const attempts = [], failures = [];
  let signal;
  const queue = createReaderProgressQueue((source, progress, abortSignal) => {
    attempts.push([source, progress.location]);
    assert.equal(Object.isFrozen(source), true);
    if (progress.location !== 'old') return;
    signal = abortSignal;
    entered.resolve();
    return gate.promise;
  }, 10000, (source, reason) => failures.push({ source, reason }));
  boundary.registerReaderProgressFlush(() => queue.flush());
  const input = { ...a };
  queue.schedule(input, { moke_book_id: '42', location: 'old' });
  const changing = boundary.withClosedReaderSession(async () => { state.sessionId = 2; });
  await entered.promise;
  input.serverUrl = b.serverUrl;
  context.mock.timers.tick(READER_PROGRESS_TIMEOUT_MS);
  await changing;
  await queue.flush();
  assert.equal(signal.aborted, true);
  assert.deepEqual(failures, [{ source: a, reason: 'timeout' }]);
  assert.equal(attempts.length, 1, 'subsequent waits do not restart the timed-out request');
  queue.schedule(b, { moke_book_id: '42', location: 'new' });
  await boundary.openReaderFromSource(b, {});
  assert.deepEqual(attempts, [[a, 'old'], [b, 'new']]);
  assert.deepEqual(boundary.sourceForReaderEvent('reader-1', '42'), b);
  gate.reject(new Error('late old-source rejection'));
  await nextTurn();
  assert.equal(failures.length, 1);
  assert.deepEqual(unhandled, []);
});

test('flush joins a timer-dispatched save using its remaining deadline rather than starting another eight seconds', async context => {
  fixture(context);
  const gate = deferred(), entered = deferred();
  let attempts = 0, complete = false, signal;
  const queue = createReaderProgressQueue((source, progress, abortSignal) => {
    attempts++;
    signal = abortSignal;
    entered.resolve();
    return gate.promise;
  }, 10);
  queue.schedule(a, { moke_book_id: '42', location: 'timer' });
  context.mock.timers.tick(10);
  await entered.promise;
  context.mock.timers.tick(4000);
  const flushing = queue.flush().then(() => { complete = true; });
  context.mock.timers.tick(READER_PROGRESS_TIMEOUT_MS - 4001);
  await nextTurn();
  assert.equal(complete, false);
  context.mock.timers.tick(1);
  await flushing;
  assert.equal(signal.aborted, true);
  await queue.flush();
  assert.equal(attempts, 1);
  gate.resolve();
  await nextTurn();
});
