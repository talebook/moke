import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SERVER_CAPABILITIES,
  getServerDiscoveryInputs,
  mergePersistedServerCapabilities,
} from '../src/lib/server-capabilities.ts';

test('持久化能力迁移剥离 legacy annotationApi 键', () => {
  const migrated = mergePersistedServerCapabilities(DEFAULT_SERVER_CAPABILITIES, {
    shelfApi: true,
    annotationApi: true,
    checkedAt: 12_345,
    version: 'legacy',
  });

  assert.equal(migrated.annotationApiStatus, 'supported');
  assert.equal(migrated.annotationApiCheckedAt, 12_345);
  assert.equal(Object.hasOwn(migrated, 'annotationApi'), false);
  assert.deepEqual(
    Object.keys(migrated).sort(),
    Object.keys(DEFAULT_SERVER_CAPABILITIES).sort(),
  );
});

test('只有 server 或通用 checkedAt 变化会改变 discovery 输入', () => {
  const capabilities = {
    ...DEFAULT_SERVER_CAPABILITIES,
    annotationApiStatus: 'unchecked',
    annotationApiCheckedAt: null,
    checkedAt: 1_000,
  };
  const initial = getServerDiscoveryInputs('http://server-a', capabilities);

  assert.deepEqual(
    getServerDiscoveryInputs('http://server-a', {
      ...capabilities,
      annotationApiStatus: 'supported',
      annotationApiCheckedAt: 2_000,
    }),
    initial,
  );
  assert.notDeepEqual(
    getServerDiscoveryInputs('http://server-b', capabilities),
    initial,
  );
  assert.notDeepEqual(
    getServerDiscoveryInputs('http://server-a', { ...capabilities, checkedAt: 1_001 }),
    initial,
  );
});
