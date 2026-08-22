import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANNOTATION_CAPABILITY_RETRY_TTL_MS,
  createUncheckedAnnotationCapability,
  getInitialAnnotationLoadState,
  shouldAutomaticallyLoadAnnotations,
} from '../src/lib/annotation-capability.ts';

test('标注能力瞬时失败在 TTL 内不自动循环请求，过期后允许重探', () => {
  const checkedAt = 10_000;
  const capability = { status: 'transient-error', checkedAt };

  assert.equal(shouldAutomaticallyLoadAnnotations(capability, checkedAt + 1), false);
  assert.equal(
    shouldAutomaticallyLoadAnnotations(capability, checkedAt + ANNOTATION_CAPABILITY_RETRY_TTL_MS - 1),
    false,
  );
  assert.equal(
    shouldAutomaticallyLoadAnnotations(capability, checkedAt + ANNOTATION_CAPABILITY_RETRY_TTL_MS),
    true,
  );
});

test('TTL 已过期的瞬时失败首帧直接进入 loading，不闪现旧错误', () => {
  const checkedAt = 10_000;
  const capability = { status: 'transient-error', checkedAt };

  assert.equal(
    getInitialAnnotationLoadState(
      capability,
      checkedAt + ANNOTATION_CAPABILITY_RETRY_TTL_MS - 1,
    ),
    'error',
  );
  assert.equal(
    getInitialAnnotationLoadState(
      capability,
      checkedAt + ANNOTATION_CAPABILITY_RETRY_TTL_MS,
    ),
    'loading',
  );
});

test('确认不支持不会按 TTL 循环探测，重新连接恢复 unchecked', () => {
  assert.equal(
    shouldAutomaticallyLoadAnnotations(
      { status: 'unsupported', checkedAt: 1 },
      1 + ANNOTATION_CAPABILITY_RETRY_TTL_MS * 2,
    ),
    false,
  );

  const reconnected = createUncheckedAnnotationCapability();
  assert.deepEqual(reconnected, { status: 'unchecked', checkedAt: null });
  assert.equal(shouldAutomaticallyLoadAnnotations(reconnected), true);
});

test('已支持状态仍加载当前书籍数据，而非额外下载样本书探测', () => {
  assert.equal(
    shouldAutomaticallyLoadAnnotations({ status: 'supported', checkedAt: Date.now() }),
    true,
  );

  const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const discoverySource = apiSource.slice(
    apiSource.indexOf('export async function discoverServerCapabilities'),
    apiSource.indexOf('export async function validateServerConnection'),
  );
  assert.doesNotMatch(discoverySource, /\/annotations/);
});
