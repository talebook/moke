import test from 'node:test';
import assert from 'node:assert/strict';

import { openAndRecordBookRead, recordBookRead } from '../src/lib/book-read.ts';

test('阅读器成功打开后通过 Talebook 阅读路由持久化一次记录', async () => {
  const events = [];
  const requests = [];

  await openAndRecordBookRead({
    open: async () => events.push('opened'),
    record: () => recordBookRead(async (url, init) => {
      events.push('recorded');
      requests.push({ url, init });
      return new Response('', { status: 200 });
    }, 'https://books.example', 'a/b'),
  });

  assert.deepEqual(events, ['opened', 'recorded']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://books.example/read/a%2Fb');
  assert.equal(requests[0].init.credentials, 'include');
});

test('阅读器打开失败时不增加阅读记录', async () => {
  let recordCalls = 0;

  await assert.rejects(
    openAndRecordBookRead({
      open: async () => { throw new Error('window failed'); },
      record: async () => { recordCalls += 1; },
    }),
    /window failed/,
  );
  assert.equal(recordCalls, 0);
});

test('记录同步失败不把已经成功的打开操作误报为失败', async () => {
  const errors = [];

  await openAndRecordBookRead({
    open: async () => {},
    record: async () => { throw new Error('network failed'); },
    onRecordError: (error) => errors.push(error),
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /network failed/);
});
