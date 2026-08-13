import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const buildCommand = fileURLToPath(new URL('../packages/moke-ext/src/commands/build.js', import.meta.url));

test('moke-ext build command is valid ESM syntax', () => {
  const result = spawnSync(process.execPath, ['--check', buildCommand], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
