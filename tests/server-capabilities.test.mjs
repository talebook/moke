import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SERVER_CAPABILITIES,
  discoverGeneralServerCapabilities,
  getServerDiscoveryInputs,
} from '../src/lib/server-capabilities.ts';

test('通用能力探测不请求样本书标注，并保持标注状态 unchecked', async () => {
  const probedPaths = [];
  const capabilities = await discoverGeneralServerCapabilities({
    version: '1.2.3',
    findSampleBookId: async () => '42',
    probeJsonEndpoint: async (path) => {
      probedPaths.push(path);
      return true;
    },
    now: () => 12_345,
  });

  assert.deepEqual(probedPaths.sort(), [
    '/api/book/42/progress',
    '/api/book/42/readstate',
    '/api/network/sources',
    '/api/reading/stats',
    '/api/shelf',
  ]);
  assert.equal(capabilities.annotationApiStatus, 'unchecked');
  assert.equal(capabilities.annotationApiCheckedAt, null);
  assert.equal(capabilities.checkedAt, 12_345);
  assert.equal(capabilities.version, '1.2.3');
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
