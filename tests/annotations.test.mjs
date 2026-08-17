import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotationReaderProgress,
  annotationSourceNames,
  clearAnnotationLocateProgressSuppression,
  fetchBookAnnotations,
  hasReadestAnnotationLocation,
  isAnnotationApiUnsupported,
  shouldSuppressAnnotationReaderProgress,
  stableMokeAnnotationClientId,
  suppressAnnotationLocateProgress,
  TALEBOOK_ANNOTATION_CONTRACT,
  upsertBookAnnotation,
  upsertBookAnnotations,
} from '../src/lib/annotations.ts';

function annotation(overrides = {}) {
  return {
    id: 7,
    book_id: 42,
    client_id: 'moke-local-1',
    annotation_type: 'note',
    is_private: true,
    cfi: null,
    chapter: '第二章',
    quote_text: '引用文字',
    content: '笔记正文',
    color: '',
    author_name: '',
    user_modified_at: null,
    created_at: '2026-08-16T08:00:00',
    updated_at: '2026-08-16T09:00:00',
    sources: [],
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Moke client_id 对同一本书和本地记录保持稳定且满足长度约束', () => {
  const first = stableMokeAnnotationClientId(42, 'local-record-9');
  assert.equal(first, stableMokeAnnotationClientId('42', 'local-record-9'));
  assert.notEqual(first, stableMokeAnnotationClientId(42, 'local-record-10'));
  assert.ok(first.length <= 64);
});

test('读取 contract v2 笔记并保留来源与无 CFI 的章节降级数据', async () => {
  const source = {
    id: 10,
    source_name: 'weread',
    source_connection_id: 'conn-1',
    source_annotation_id: 'remote-1',
    source_run_id: 'run-2',
    source_position: 'chapter:2',
    source_raw_hash: 'hash',
    source_updated_at: '2026-08-16T08:00:00',
    source_sync_status: 'synced',
    source_synced_at: '2026-08-16T08:01:00',
    source_sync_error: null,
  };
  const items = await fetchBookAnnotations(
    async (url, init) => {
      assert.equal(url, 'http://talebook/api/book/42/annotations');
      assert.equal(init.credentials, 'include');
      return jsonResponse({ err: 'ok', annotations: [annotation({ sources: [source] })] });
    },
    'http://talebook',
    42,
  );

  assert.equal(items[0].cfi, null);
  assert.equal(items[0].chapter, '第二章');
  assert.deepEqual(annotationSourceNames(items[0]), ['weread']);
  assert.equal(annotationReaderProgress(items[0], 42), null);
});

test('CFI 标注转换为 Readest 精确定位进度', () => {
  const item = annotation({ cfi: '  epubcfi(/6/4!/4/2/8)  ' });
  const progress = annotationReaderProgress(item, 42);
  assert.equal(hasReadestAnnotationLocation(item), true);
  assert.equal(progress.schema, 'moke.readest.progress.v1');
  assert.equal(progress.location, 'epubcfi(/6/4!/4/2/8)');
  assert.equal(progress.chapter, '第二章');

  const external = annotation({ cfi: 'calibre-position:chapter-2' });
  assert.equal(hasReadestAnnotationLocation(external), false);
  assert.equal(annotationReaderProgress(external, 42), null);
});

test('标注定位恢复位置不会覆盖普通阅读进度，用户翻页后恢复同步', () => {
  const target = 'epubcfi(/6/4!/4/2/8)';
  suppressAnnotationLocateProgress(42, target);
  const restored = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: '42',
    location: target,
    updated_at: new Date().toISOString(),
  };
  assert.equal(shouldSuppressAnnotationReaderProgress(restored), true);
  assert.equal(shouldSuppressAnnotationReaderProgress(restored), true);
  assert.equal(shouldSuppressAnnotationReaderProgress({ ...restored, location: 'epubcfi(/6/6)' }), false);
  assert.equal(shouldSuppressAnnotationReaderProgress(restored), false);
  clearAnnotationLocateProgressSuppression(42);
});

test('429/5xx/网络错误有限重试，登录失效不会重试', async () => {
  let attempts = 0;
  const items = await fetchBookAnnotations(
    async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse({ err: 'busy', msg: '稍后重试' }, 503);
      return jsonResponse({ err: 'ok', annotations: [annotation()] });
    },
    'http://talebook',
    42,
    { retryDelayMs: 0, sleep: async () => {} },
  );
  assert.equal(attempts, 3);
  assert.equal(items.length, 1);

  attempts = 0;
  await assert.rejects(
    () => fetchBookAnnotations(
      async () => {
        attempts += 1;
        return jsonResponse({ err: 'user.need_login', msg: '请登录' });
      },
      'http://talebook',
      42,
      { retryDelayMs: 0, sleep: async () => {} },
    ),
    (error) => error.code === 'user.need_login',
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await fetchBookAnnotations(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('error sending request for url: connection refused');
      if (attempts === 2) throw new Error('operation timed out');
      return jsonResponse({ err: 'ok', annotations: [] });
    },
    'http://talebook',
    42,
    { retryDelayMs: 0, sleep: async () => {} },
  );
  assert.equal(attempts, 3);
});

test('重复 upsert 复用 client_id，且来源字段使用 v2 source_ 前缀', async () => {
  const ids = new Map();
  let nextId = 1;
  const bodies = [];
  const requestLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const identity = body.client_id || `${body.source_name}:${body.source_connection_id}:${body.source_annotation_id}`;
    if (!ids.has(identity)) ids.set(identity, nextId++);
    return jsonResponse({
      err: 'ok',
      created: bodies.length === 1,
      stale_ignored: false,
      conflict_protected: false,
      sync_enqueued: false,
      annotation: annotation({ id: ids.get(identity), client_id: body.client_id || null }),
    });
  };

  const input = { annotation_type: 'highlight', client_id: 'moke-stable-1', quote_text: '相同高亮' };
  const first = await upsertBookAnnotation(requestLike, 'http://talebook', 42, input);
  const second = await upsertBookAnnotation(requestLike, 'http://talebook', 42, input);
  assert.equal(first.annotation.id, second.annotation.id);
  assert.equal(ids.size, 1);

  await upsertBookAnnotation(requestLike, 'http://talebook', 42, {
    annotation_type: 'bookmark',
    source_name: 'moke',
    source_connection_id: 'desktop-1',
    source_annotation_id: 'bookmark-9',
    source_position: 'chapter:3',
  });
  assert.equal(bodies[2].source_name, 'moke');
  assert.equal(bodies[2].source_annotation_id, 'bookmark-9');
  assert.equal('source' in bodies[2], false);
  assert.equal('external_id' in bodies[2], false);
});

test('写入不重试服务端 5xx，但响应丢失时可按相同幂等键重试', async () => {
  let attempts = 0;
  await assert.rejects(
    () => upsertBookAnnotation(
      async () => {
        attempts += 1;
        return jsonResponse({ err: 'server.error', msg: '配置错误' }, 500);
      },
      'http://talebook',
      42,
      { annotation_type: 'note', client_id: 'no-5xx-retry' },
      { retryDelayMs: 0, sleep: async () => {} },
    ),
    (error) => error.status === 500,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  const result = await upsertBookAnnotation(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return jsonResponse({
        err: 'ok',
        created: false,
        stale_ignored: false,
        conflict_protected: false,
        sync_enqueued: false,
        annotation: annotation({ client_id: 'safe-network-retry' }),
      });
    },
    'http://talebook',
    42,
    { annotation_type: 'note', client_id: 'safe-network-retry' },
    { retryDelayMs: 0, sleep: async () => {} },
  );
  assert.equal(attempts, 2);
  assert.equal(result.annotation.client_id, 'safe-network-retry');

  attempts = 0;
  await upsertBookAnnotation(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('error sending request for url: operation timed out');
      return jsonResponse({
        err: 'ok',
        annotation: annotation({ client_id: 'tauri-network-retry' }),
      });
    },
    'http://talebook',
    42,
    { annotation_type: 'note', client_id: 'tauri-network-retry' },
    { retryDelayMs: 0, sleep: async () => {} },
  );
  assert.equal(attempts, 2);
});

test('POST 精简响应按提交内容补全，不把已成功写入误报为契约失败', async () => {
  const result = await upsertBookAnnotation(
    async () => jsonResponse({
      err: 'ok',
      created: true,
      annotation: { id: '19', annotation_type: 'note', content: '服务端正文' },
    }),
    'http://talebook',
    42,
    {
      annotation_type: 'note',
      client_id: 'compact-response',
      chapter: '第三章',
      content: '提交正文',
      is_private: false,
    },
  );
  assert.equal(result.annotation.id, 19);
  assert.equal(result.annotation.book_id, 42);
  assert.equal(result.annotation.client_id, 'compact-response');
  assert.equal(result.annotation.chapter, '第三章');
  assert.equal(result.annotation.content, '服务端正文');
  assert.equal(result.annotation.is_private, false);
  assert.deepEqual(result.annotation.sources, []);
});

test('空来源字段不触发伪部分来源错误，talebook 来源身份可合法回写', async () => {
  const bodies = [];
  const requestLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return jsonResponse({ err: 'ok', annotation: annotation({ client_id: body.client_id ?? null }) });
  };
  await upsertBookAnnotation(requestLike, 'http://talebook', 42, {
    annotation_type: 'note',
    client_id: 'nullable-source-fields',
    source_name: null,
    source_connection_id: '   ',
  });
  await upsertBookAnnotation(requestLike, 'http://talebook', 42, {
    annotation_type: 'highlight',
    source_name: 'talebook',
    source_annotation_id: 'native-9',
  });
  assert.equal(bodies.length, 2);
});

test('批量 upsert 报告部分成功并保留失败项供恢复', async () => {
  const result = await upsertBookAnnotations(
    async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.client_id === 'denied') {
        return jsonResponse({ err: 'permission.denied', msg: '没有权限' }, 403);
      }
      return jsonResponse({
        err: 'ok',
        created: true,
        stale_ignored: false,
        conflict_protected: false,
        sync_enqueued: false,
        annotation: annotation({ client_id: body.client_id }),
      });
    },
    'http://talebook',
    42,
    [
      { annotation_type: 'note', client_id: 'ok-1', content: '成功' },
      { annotation_type: 'note', client_id: 'denied', content: '失败' },
    ],
    { maxRetries: 0 },
  );
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].input.client_id, 'denied');
  assert.equal(result.failed[0].retryable, false);
});

test('批量 upsert 按配置限制并发请求数', async () => {
  let active = 0;
  let maxActive = 0;
  const inputs = Array.from({ length: 17 }, (_, index) => ({
    annotation_type: 'note',
    client_id: `batch-${index}`,
  }));
  const result = await upsertBookAnnotations(
    async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const body = JSON.parse(init.body);
      return jsonResponse({
        err: 'ok',
        created: true,
        stale_ignored: false,
        conflict_protected: false,
        sync_enqueued: false,
        annotation: annotation({ id: Number(body.client_id.replace('batch-', '')) + 1, client_id: body.client_id }),
      });
    },
    'http://talebook',
    42,
    inputs,
    { maxRetries: 0, concurrency: 4 },
  );
  assert.equal(result.succeeded.length, inputs.length);
  assert.ok(maxActive <= 4, `并发峰值 ${maxActive} 应 <= 4`);

  active = 0;
  maxActive = 0;
  await upsertBookAnnotations(
    async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const body = JSON.parse(init.body);
      return jsonResponse({ err: 'ok', annotation: annotation({ client_id: body.client_id }) });
    },
    'http://talebook',
    42,
    inputs.slice(0, 3),
    { maxRetries: 0, concurrency: 0 },
  );
  assert.equal(maxActive, 1);
});

test('旧服务器或非数组响应明确标记为 contract 不兼容', async () => {
  await assert.rejects(
    () => fetchBookAnnotations(
      async () => jsonResponse({ err: 'page.not_found' }, 404),
      'http://talebook',
      42,
      { maxRetries: 0 },
    ),
    (error) => isAnnotationApiUnsupported(error)
      && error.message.includes(TALEBOOK_ANNOTATION_CONTRACT),
  );

  await assert.rejects(
    () => fetchBookAnnotations(
      async () => jsonResponse({ err: 'ok', annotations: { id: 1 } }),
      'http://talebook',
      42,
      { maxRetries: 0 },
    ),
    isAnnotationApiUnsupported,
  );
});

test('单条畸形记录不会隐藏同一响应中的合法笔记', async () => {
  const items = await fetchBookAnnotations(
    async () => jsonResponse({
      err: 'ok',
      annotations: [
        annotation({ id: 1 }),
        { id: 'broken', content: '不完整记录' },
        annotation({ id: 2, sources: [{ source_name: 'missing-required-fields' }] }),
        annotation({ id: 3, content: '仍可展示' }),
      ],
    }),
    'http://talebook',
    42,
    { maxRetries: 0 },
  );
  assert.deepEqual(items.map((item) => item.id), [1, 3]);
});

test('非空响应全部畸形时报告契约不兼容，书籍 404 不误报接口缺失', async () => {
  await assert.rejects(
    () => fetchBookAnnotations(
      async () => jsonResponse({ err: 'ok', annotations: [{ id: 'broken' }, { content: 'bad' }] }),
      'http://talebook',
      42,
      { maxRetries: 0 },
    ),
    isAnnotationApiUnsupported,
  );

  await assert.rejects(
    () => fetchBookAnnotations(
      async () => jsonResponse({ err: 'book.not_found', msg: '书籍不存在' }, 404),
      'http://talebook',
      42,
      { maxRetries: 0 },
    ),
    (error) => error.code === 'book.not_found' && !isAnnotationApiUnsupported(error),
  );
});
