import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function executeHook(source, properties = {}, extParams = {}) {
  const invocations = [];
  let rustBuild;
  const js = stripTypeScriptTypes(source
    .replace(/^import .*;\n/gm, '')
    .replace('export default', 'module.exports ='));
  const context = {
    module: { exports: {} },
    hapTasks: {},
    __dirname: '/project/src-tauri/gen/ohos/entry',
    resolve,
    hvigor: { getParameter: () => ({
      getProperties: () => properties,
      getExtParam: (name) => extParams[name],
    }) },
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
  const [call] = executeHook(template, {}, { buildMode: 'release' });
  assert.deepEqual(call.args, ['ohos', 'dev-eco-studio-script', '--target', 'aarch64']);
});

test('patched hook passes --release only for release; preserves target and executable', () => {
  const patched = patchHvigorRustProfile(template);
  assert.equal(patchHvigorRustProfile(patched), patched);
  for (const buildMode of ['release', 'debug', undefined]) {
    const calls = executeHook(patched, { target: 'x86_64' }, { buildMode });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/tools/cargo-tauri');
    assert.deepEqual(calls[0].args, [
      'ohos', 'dev-eco-studio-script', '--target', 'x86_64',
      ...(buildMode === 'release' ? ['--release'] : []),
    ]);
    assert.equal(calls[0].options.stdio, 'inherit');
    assert.equal(calls[0].options.cwd, '/project');
  }
});

test('external buildMode controls the profile even when properties conflict', () => {
  const patched = patchHvigorRustProfile(template);
  for (const buildMode of ['debug', undefined]) {
    const [call] = executeHook(patched, { buildMode: 'release' }, { buildMode });
    assert.deepEqual(call.args, ['ohos', 'dev-eco-studio-script', '--target', 'aarch64']);
  }
  const [call] = executeHook(patched, { buildMode: 'debug' }, { buildMode: 'release' });
  assert.deepEqual(call.args, ['ohos', 'dev-eco-studio-script', '--target', 'aarch64', '--release']);
});

const legacyDeclaration = 'const rustProfileArgs = properties.buildMode === "release" ? ["--release"] : [];';
const legacyPatched = template
  .replace('const target = properties.target || "aarch64";',
    `const target = properties.target || "aarch64";\n        ${legacyDeclaration}`)
  .replace('"--target", target.toString()]', '"--target", target.toString(), ...rustProfileArgs]');

test('complete legacy patches are upgraded to the external parameter channel', () => {
  const patched = patchHvigorRustProfile(legacyPatched);
  assert.notEqual(patched, legacyPatched);
  assert.equal(patched, patchHvigorRustProfile(template));
  assert.equal(patchHvigorRustProfile(patched), patched);
  const [call] = executeHook(patched, {}, { buildMode: 'release' });
  assert.ok(call.args.includes('--release'));
});

test('release preparation CLI patches the generated hook and rejects unknown hooks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-rust-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ohos = join(root, 'src-tauri/gen/ohos');
  mkdirSync(join(ohos, 'AppScope'), { recursive: true });
  mkdirSync(join(ohos, 'entry'), { recursive: true });
  const appFile = join(ohos, 'AppScope/app.json5');
  const app = '{"app":{"bundleName":"org.houheya.moke","versionCode":7}}';
  writeFileSync(appFile, app);
  const hookFile = join(ohos, 'entry/hvigorfile.ts');
  const script = new URL('../scripts/prepare-ohos-release.mjs', import.meta.url);
  for (const source of [template, legacyPatched]) {
    writeFileSync(hookFile, source);
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [fileURLToPath(script)], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const [call] = executeHook(readFileSync(hookFile, 'utf8'), {}, { buildMode: 'release' });
      assert.ok(call.args.includes('--release'));
      assert.equal(readFileSync(appFile, 'utf8'), app);
    }
  }
  for (const invalid of [
    'export default { system: {}, plugins: [] };',
    patchHvigorRustProfile(template).replace(', ...rustProfileArgs', ''),
    patchHvigorRustProfile(template).replace(/const rustProfileArgs = .*;\n/, ''),
    legacyPatched.replace(', ...rustProfileArgs', ''),
    template.replace('target.toString()', 'String(target)'),
  ]) {
    writeFileSync(hookFile, invalid);
    const result = spawnSync(process.execPath, [fileURLToPath(script)], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported OHOS Hvigor Rust hook|Partially patched/);
    assert.equal(readFileSync(hookFile, 'utf8'), invalid);
    assert.equal(readFileSync(appFile, 'utf8'), app);
  }
});

test('partial patches fail instead of shipping an ambiguous native build profile', () => {
  const patched = patchHvigorRustProfile(template);
  assert.throws(() => patchHvigorRustProfile(
    patched.replace(', ...rustProfileArgs', ''),
  ), /Partially patched/);
  assert.throws(() => patchHvigorRustProfile(
    patched.replace(/const rustProfileArgs = .*;\n/, ''),
  ), /Partially patched/);
  assert.throws(() => patchHvigorRustProfile(
    legacyPatched.replace(', ...rustProfileArgs', ''),
  ), /Partially patched/);
  assert.throws(() => patchHvigorRustProfile(
    template.replace('target.toString()', 'String(target)'),
  ), /Unsupported/);
});
