import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderSourceBoundary, ReaderOpenUnconfirmedError } from '../src/lib/reader-source.ts';

const source = { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const stage of ['already-aborted', 'window snapshot', 'progress flush', 'session context']) {
  test(`cancelled Reader preparation at ${stage} cannot dispatch or create phantom ownership`, async () => {
    const gate = deferred(), entered = deferred();
    const controller = new AbortController();
    const signal = { get aborted() { return controller.signal.aborted; } };
    const state = { labels: [], opens: 0 };
    const waitForStage = async expected => {
      if (stage !== expected) return;
      entered.resolve();await gate.promise;
    };
    const boundary = createReaderSourceBoundary({
      getWindowLabels: async () => { await waitForStage('window snapshot'); return state.labels; },
      getContext: async () => { await waitForStage('session context'); return { sessionId: 1, candidate: null }; },
      open: async () => { state.opens++; state.labels = ['reader-new']; },
      wait: async () => assert.fail('dispatch must not reach observation'), now: () => 0,
    });
    const remove = boundary.registerReaderProgressFlush(async () => { await waitForStage('progress flush'); });
    try {
      if (stage === 'already-aborted') controller.abort();
      const rejected = assert.rejects(boundary.openReaderFromSource(source, {}, signal), { name: 'AbortError' });
      if (stage !== 'already-aborted') { await entered.promise; controller.abort(); }
      gate.resolve();await rejected;
      assert.equal(state.opens, 0);
      remove();
      await boundary.requireClosedReaders();
      assert.equal(boundary.sourceForReaderEvent('reader-new', '42'), null);
    } finally { remove();gate.resolve(); }
  });
}

test('cancellation after native dispatch cannot release an unconfirmed queued Reader', async () => {
  const gate = deferred(), entered = deferred();
  const controller = new AbortController();
  const state = { labels: [] };
  const boundary = createReaderSourceBoundary({
    getWindowLabels: async () => state.labels,
    getContext: async () => ({ sessionId: 1, candidate: null }),
    open: async () => { entered.resolve();await gate.promise; },
    wait: async () => {}, now: () => 0,
  });
  const rejected = assert.rejects(boundary.openReaderFromSource(source, {}, controller.signal), ReaderOpenUnconfirmedError);
  await entered.promise;
  controller.abort();gate.reject(new Error('lost native dispatch receipt'));
  await rejected;
  await assert.rejects(boundary.requireClosedReaders(), { code: 'reader.open_unconfirmed' });
  state.labels = ['reader-late'];
  await assert.rejects(boundary.requireClosedReaders(), { code: 'reader.windows_open' });
  assert.deepEqual(boundary.sourceForReaderEvent('reader-late', '42'), source);
});
