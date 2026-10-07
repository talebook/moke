import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { patchHvigorRustProfile } from '../scripts/prepare-ohos-release.mjs';

// Exercise the actual pinned Tauri hook, including its afterRun registration.
const template = readFileSync(new URL(
  '../vendor/tauri/crates/tauri-cli/templates/mobile/open-harmony/entry/hvigorfile.ts',
  import.meta.url,
), 'utf8')
  .replace('{{tauri-binary}}', '/tools/cargo-tauri')
  .replace('{{quote-and-join tauri-binary-args}}', '"ohos", "dev-eco-studio-script"')
  .replace('{{root-dir-rel}}', '../../../..');

function executeHook(source, properties) {
  const invocations = [];
  let rustBuild;
  const js = stripTypeScriptTypes(source
    .replace(/^import .*;\n/gm, '')
    .replace('export default', 'module.exports ='));
  const context = {
    module: { exports: {} },
    hapTasks: {},
    __dirname: '/project/src-tauri/gen/ohos/entry',
    resolve: (...parts) => parts.join('/'),
    hvigor: { getParameter: () => ({ getProperties: () => properties }) },
    execFileSync: (command, args, options) => {
      invocations.push({ command, args: Array.from(args), options });
    },
  };
  vm.runInNewContext(js, context);
  context.module.exports.plugins[0].apply({
    getTaskByName: (name) => {
      assert.equal(name, 'default@ConfigureCmake');
      return { afterRun: (callback) => { rustBuild = callback; } };
    },
  });
  assert.equal(typeof rustBuild, 'function');
  rustBuild();
  return invocations;
}

test('unpatched upstream hook reproduces release HAP invoking a debug Rust build', () => {
  const [call] = executeHook(template, { buildMode: 'release' });
  assert.deepEqual(call.args, ['ohos', 'dev-eco-studio-script', '--target', 'aarch64']);
});

test('patched hook passes --release only for release; preserves target and executable', () => {
  const patched = patchHvigorRustProfile(template);
  assert.equal(patchHvigorRustProfile(patched), patched);
  for (const buildMode of ['release', 'debug', undefined]) {
    const calls = executeHook(patched, { buildMode, target: 'x86_64' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/tools/cargo-tauri');
    assert.deepEqual(calls[0].args, [
      'ohos', 'dev-eco-studio-script', '--target', 'x86_64',
      ...(buildMode === 'release' ? ['--release'] : []),
    ]);
    assert.equal(calls[0].options.stdio, 'inherit');
  }
});

test('release preparation CLI patches the generated hook and rejects unknown hooks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-rust-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ohos = join(root, 'src-tauri/gen/ohos');
  mkdirSync(join(ohos, 'AppScope'), { recursive: true });
  mkdirSync(join(ohos, 'entry'), { recursive: true });
  const appFile = join(ohos, 'AppScope/app.json5');
  const app = '{"app":{"bundleName":"org.houheya.moke_openharmony","versionCode":7}}';
  writeFileSync(appFile, app);
  const hookFile = join(ohos, 'entry/hvigorfile.ts');
  writeFileSync(hookFile, template);
  const script = new URL('../scripts/prepare-ohos-release.mjs', import.meta.url);
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [fileURLToPath(script)], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [call] = executeHook(readFileSync(hookFile, 'utf8'), { buildMode: 'release' });
    assert.ok(call.args.includes('--release'));
    assert.equal(readFileSync(appFile, 'utf8'), app);
  }
  const unknown = 'export default { system: {}, plugins: [] };';
  writeFileSync(hookFile, unknown);
  const result = spawnSync(process.execPath, [fileURLToPath(script)], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported OHOS Hvigor Rust hook/);
  assert.equal(readFileSync(hookFile, 'utf8'), unknown);
});

test('partial patches fail instead of shipping an ambiguous native build profile', () => {
  const patched = patchHvigorRustProfile(template);
  assert.throws(() => patchHvigorRustProfile(
    patched.replace(', ...rustProfileArgs', ''),
  ), /Partially patched/);
  assert.throws(() => patchHvigorRustProfile(
    template.replace('target.toString()', 'String(target)'),
  ), /Unsupported/);
});
