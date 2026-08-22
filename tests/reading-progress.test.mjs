import test from 'node:test';
import assert from 'node:assert/strict';

import { readingProgressForPersistence } from '../src/lib/reading-progress-payload.ts';

test('持久化阅读进度时剥离临时导航关联字段', () => {
  const progress = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: '42',
    location: 'epubcfi(/6/4)',
    moke_navigation_id: 'annotation-locate-42',
    moke_navigation_kind: 'annotation-locate',
    moke_navigation_phase: 'complete',
    updated_at: '2026-08-22T00:00:00.000Z',
  };

  assert.deepEqual(readingProgressForPersistence(progress), {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: '42',
    location: 'epubcfi(/6/4)',
    updated_at: '2026-08-22T00:00:00.000Z',
  });
});
