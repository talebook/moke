import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDiscoveryAdapter } from '../src/lib/discovery/native.ts';

test('only app-reported Windows and Linux may enter native discovery IPC', async () => {
  for (const platform of ['windows', 'linux']) {
    const calls = [];
    const adapter = createNativeDiscoveryAdapter(async (command, args) => {
      calls.push({ command, args });
      if (command === 'moke_runtime_platform') return platform;
      return { status: 'searching', rows: [] };
    });
    const sessionId = '9f0c663b-8ffd-4e13-92d9-2b68572c08b1';
    assert.equal(calls.length, 0);
    await adapter.start(sessionId);
    await adapter.snapshot(sessionId);
    await adapter.stop(sessionId);
    assert.deepEqual(calls, [
      { command: 'moke_runtime_platform', args: undefined },
      { command: 'moke_discovery_start', args: { sessionId } },
      { command: 'moke_discovery_snapshot', args: { sessionId } },
      { command: 'moke_discovery_stop', args: { sessionId } },
    ]);
  }
});

test('OHOS, Apple and Android stay unsupported without requesting discovery grants', async () => {
  for (const platform of ['ohos', 'macos', 'ios', 'android', 'web', 'unknown']) {
    const calls = [];
    const adapter = createNativeDiscoveryAdapter(async (command) => {
      calls.push(command);
      return platform;
    });
    await assert.rejects(adapter.start('session'), (error) => error.code === 'unsupported');
    await adapter.stop('session');
    assert.deepEqual(calls, ['moke_runtime_platform'], platform);
  }
});

test('a runtime query failure never falls back to a potentially incorrect OS plugin result', async () => {
  const calls = [];
  const adapter = createNativeDiscoveryAdapter(async (command) => {
    calls.push(command);
    throw new Error('IPC unavailable');
  });
  await assert.rejects(adapter.start('session'), /IPC unavailable/);
  await adapter.stop('session');
  assert.deepEqual(calls, ['moke_runtime_platform']);
});
