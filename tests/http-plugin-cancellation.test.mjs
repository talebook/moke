import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// An unhandled rejection is the regression under test. Keep the real plugin in
// a child process so observing the broken dependency cannot poison node:test.
async function exerciseCancellation(entry, scenario) {
  const assert = (await import('node:assert/strict')).default;
  const { createRequire } = await import('node:module');
  const { fetch } = entry === 'esm'
    ? await import('@tauri-apps/plugin-http')
    : createRequire(import.meta.url)('@tauri-apps/plugin-http');
  const unhandled = [];
  const collect = (reason) => unhandled.push(String(reason));
  process.on('unhandledRejection', collect);
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };
  const calls = [];
  const requestId = 10;
  const bodyId = 20;
  const bodyStarted = Promise.withResolvers();
  const bodyPending = Promise.withResolvers();
  const readFailure = new Error('native response body read failed');
  let readCalls = 0;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case 'plugin:http|fetch':
        assert.equal(args.clientConfig.url, 'https://books.test/cover.png');
        return requestId;
      case 'plugin:http|fetch_send':
        assert.equal(args.rid, requestId);
        return { status: 200, statusText: 'OK', url: 'https://books.test/cover.png',
          rid: bodyId, headers: [['content-type', 'image/png']] };
      case 'plugin:http|fetch_read_body':
        assert.equal(args.rid, bodyId);
        readCalls += 1;
        bodyStarted.resolve();
        if (scenario === 'completed') return readCalls === 1 ? [79, 75, 0] : [1];
        return bodyPending.promise;
      case 'plugin:http|fetch_cancel':
        assert.equal(args.rid, requestId);
        throw new Error('request resource already released');
      case 'plugin:http|fetch_cancel_body':
        assert.equal(args.rid, bodyId);
        throw new Error('body resource already released');
      default:
        assert.fail(`Unexpected native command: ${command}`);
    }
  } } };

  const controller = new AbortController();
  const response = await fetch('https://books.test/cover.png', { signal: controller.signal });
  if (scenario === 'completed') {
    assert.equal(await response.text(), 'OK');
    controller.abort();
  } else if (scenario === 'read-failure') {
    const reading = response.text();
    const rejected = assert.rejects(reading, error => error === readFailure);
    await bodyStarted.promise;
    bodyPending.reject(readFailure);
    await rejected;
    await settle();
    controller.abort();
  } else {
    const reader = response.body.getReader();
    const reading = reader.read();
    await bodyStarted.promise;
    await reader.cancel('cover unmounted');
    assert.deepEqual(await reading, { value: undefined, done: true });
    // Native work can fail after consumer cancellation. The late failure and
    // subsequent signal abort must share the same one-time body disposal.
    bodyPending.reject(readFailure);
    await settle();
    controller.abort();
    reader.releaseLock();
  }
  await settle();
  process.off('unhandledRejection', collect);
  return {
    unhandled,
    requestCancels: calls.filter(call => call.command === 'plugin:http|fetch_cancel').length,
    bodyDrops: calls.filter(call => call.command === 'plugin:http|fetch_cancel_body').length,
    commands: [...new Set(calls.map(call => call.command))].sort(),
  };
}

const expectedCommands = [
  'plugin:http|fetch',
  'plugin:http|fetch_cancel',
  'plugin:http|fetch_cancel_body',
  'plugin:http|fetch_read_body',
  'plugin:http|fetch_send',
].sort();

for (const entry of ['esm', 'cjs']) {
  for (const scenario of ['completed', 'read-failure', 'consumer-cancel']) {
    test(`HTTP ${entry}: ${scenario} handles released native resources and disposes the body once`, () => {
      const script = `const result = await (${exerciseCancellation.toString()})(${JSON.stringify(entry)}, ${JSON.stringify(scenario)}); console.log(JSON.stringify(result));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.deepEqual(result.unhandled, [], 'native cancellation failures must be consumed');
      assert.equal(result.requestCancels, 1);
      assert.equal(result.bodyDrops, 1, 'read failure, cancellation and abort must share one body disposal');
      assert.deepEqual(result.commands, expectedCommands);
    });
  }
}
