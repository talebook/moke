import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');

test('开发编排直接启动 Next，正常关闭不经过 pnpm 失败包装', () => {
  assert.match(source, /spawn\(process\.execPath/);
  assert.doesNotMatch(source, /--env-file/);
  assert.match(source, /readEnvFile\(path\.join\(directory, '\.env\.tauri'\)\)/);
  assert.match(source, /env: devEnv\(readerRoot/);
  assert.match(source, /env: devEnv\(root\)/);
  assert.doesNotMatch(source, /spawn\('pnpm'/);
  assert.match(source, /process\.on\('SIGTERM', \(\) => cleanup\(0\)\)/);
});
