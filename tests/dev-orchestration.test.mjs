import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');

test('开发编排直接启动 Next，正常关闭不经过 pnpm 失败包装', () => {
  assert.match(source, /spawn\(process\.execPath/);
  assert.doesNotMatch(source, /--env-file/);
  assert.match(source, /readEnvFile\(path\.join\(directory, envFile\)\)/);
  assert.match(source, /existsSync\(filePath\)/);
  assert.match(source, /Missing development environment file/);
  assert.match(source, /git submodule update --init --recursive/);
  assert.match(source, /env: devEnv\(readerRoot, '\.env\.moke-reader'/);
  assert.match(source, /env: devEnv\(root, '\.env\.tauri'\)/);
  assert.match(source, /await waitForReader\('http:\/\/localhost:3001\/readest\/reader'\)/);
  assert.match(source, /if \(!response\.ok\)/);
  assert.ok(
    source.indexOf("await waitForReader('http://localhost:3001/readest/reader')") <
      source.indexOf('moke = spawn(process.execPath'),
    '应先完成 Reader 首次编译，再启动 Moke 开发服务',
  );
  assert.doesNotMatch(source, /spawn\('pnpm'/);
  assert.match(source, /process\.on\('SIGTERM', \(\) => cleanup\(0\)\)/);
});
