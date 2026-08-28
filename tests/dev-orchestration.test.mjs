import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');

test('开发编排直接启动 Next，正常关闭不经过 pnpm 失败包装', () => {
  assert.match(source, /spawn\(process\.execPath/);
  assert.match(source, /--env-file=\.env\.tauri/);
  assert.doesNotMatch(source, /spawn\('pnpm'/);
  assert.match(source, /process\.on\('SIGTERM', \(\) => cleanup\(0\)\)/);
});
