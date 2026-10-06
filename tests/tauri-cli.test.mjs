import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tauriCommand } from '../scripts/tauri.mjs';

test('OHOS dev uses the pinned source CLI and preserves device arguments', () => {
  const args = ['-v', 'ohos', 'dev', '--host', '10.0.2.2', '--no-watch'];
  const command = tauriCommand(args);
  assert.equal(command.command, 'cargo');
  assert.ok(command.args.includes('--locked'));
  assert.ok(command.args.includes('--no-default-features'));
  assert.equal(command.args[command.args.indexOf('--features') + 1], 'rustls');
  assert.match(command.args[command.args.indexOf('--manifest-path') + 1], /vendor[/\\]tauri[/\\]Cargo.toml$/);
  assert.deepEqual(command.args.slice(command.args.indexOf('--') + 1), args);
});

test('standard commands and paths containing ohos still use the npm CLI', () => {
  for (const args of [[], ['--version'], ['android', 'dev'], ['build', '--config', 'ohos']]) {
    const command = tauriCommand(args);
    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args.slice(1), args);
  }
});

test('OHOS release CI uses the same locked upstream CLI TLS features', () => {
  const workflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
  const build = workflow.split('\n').find((line) => line.includes('cargo build') && line.includes('-p tauri-cli'));
  assert.ok(build);
  assert.match(build, /--locked\b/);
  assert.match(build, /--no-default-features --features rustls\b/);
});
