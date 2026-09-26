import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { integrateOpener, prepareOpener } from '../scripts/ohos-opener-prepare.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const template = read('vendor/tauri/crates/tauri-cli/templates/mobile/open-harmony/entry/src/main/ets/entryability/EntryAbility.ets');

test('OHOS opener lifecycle integration is repeatable and preserves official window behavior', () => {
  const result = integrateOpener(template);
  assert.equal(integrateOpener(result), result);
  assert.ok(result.indexOf('this.mokeOpener.install(') < result.indexOf('await super.onCreate('));
  assert.ok(result.indexOf('this.mokeOpener.dispose()') < result.indexOf('return super.onDestroy()'));
  assert.match(result, /await window.setWindowLayoutFullScreen\(false\)/);
  assert.match(result, /super.onWindowStageCreate\(windowStage\)/);
});

test('OHOS opener fails on unexpected or partially integrated lifecycle', () => {
  assert.throws(() => integrateOpener('class Unknown {}'), /Unsupported/);
  assert.throws(() => integrateOpener(template.replace('super.onCreate', 'super.changed')), /Unsupported/);
  assert.throws(() => integrateOpener(`${template}\nonDestroy() {}`), /Unsupported/);
  assert.throws(() => integrateOpener(`import { OhosOpener } from './Opener';\n${template}`), /Partially/);
});

test('prepare copies only the app-owned adapter and can run twice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-opener-'));
  try {
    const entryDir = join(directory, 'entry/src/main/ets/entryability');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'EntryAbility.ets'), template);
    const adapter = fileURLToPath(new URL('../scripts/ohos-opener/Opener.ets', import.meta.url));
    prepareOpener(directory, adapter);
    prepareOpener(directory, adapter);
    assert.equal(readFileSync(join(entryDir, 'EntryAbility.ets'), 'utf8'), integrateOpener(template));
    assert.equal(readFileSync(join(entryDir, 'Opener.ets'), 'utf8'), readFileSync(adapter, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Tauri/Wry remain official, fs/shell/opener share the dedicated plugin fork', () => {
  const manifest = read('src-tauri/Cargo.toml');
  const patches = manifest.split('[patch.crates-io]')[1];
  for (const name of ['fs', 'shell', 'opener']) {
    assert.ok(patches.includes(`tauri-plugin-${name} = { path = "../vendor/ohos-plugins/plugins/${name}" }`));
  }
  assert.match(read('.gitmodules'), /url = https:\/\/github.com\/tauri-apps\/wry.git/);
  assert.match(read('src-tauri/tauri.ohos.conf.json'), /beforeDevCommand.*prepare-ohos/);
});

test('Cargo locks each adapted plugin once from the fork, matching the exact host version', () => {
  const manifest = read('src-tauri/Cargo.toml');
  const packages = read('src-tauri/Cargo.lock').split('[[package]]');
  for (const name of ['fs', 'shell', 'opener']) {
    const crate = `tauri-plugin-${name}`;
    const version = manifest.match(new RegExp(`^${crate} = "=([^\"]+)"`, 'm'))?.[1];
    assert.ok(version, `${crate} must have an exact host version`);
    const locked = packages.filter((entry) => entry.includes(`\nname = "${crate}"\n`));
    assert.equal(locked.length, 1, `${crate} must resolve to one instance`);
    assert.ok(locked[0].includes(`\nversion = "${version}"\n`));
    assert.doesNotMatch(locked[0], /\nsource = /, `${crate} must use the patched submodule, not crates.io`);
  }
});

// Execute the actual adapter with native API mocks. This verifies dispatch and
// completion semantics, but is not a substitute for the ArkTS SDK/device check.
function adapterHarness() {
  const calls = [];
  const replies = [];
  let callback;
  let pending = true;
  const native = {
    registerOhosOpener(fn) { callback = fn; },
    completeOhosOpener(...args) { replies.push(args); },
    isOhosOpenerPending() { return pending; },
    unregisterOhosOpener() { pending = false; },
  };
  const context = {
    async openLink(url) { calls.push(['link', url]); },
    async startAbility(want) { calls.push(['ability', want]); },
  };
  const exported = {};
  const compiled = ts.transpileModule(read('scripts/ohos-opener/Opener.ets'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const requireKit = (name) => {
    if (name === '@kit.AbilityKit') return { wantConstant: { Flags: { FLAG_AUTH_READ_URI_PERMISSION: 1 } } };
    if (name === '@kit.CoreFileKit') return { fileUri: { getUriFromPath: (path) => `file://app${path}` } };
    throw new Error(`Unexpected native import: ${name}`);
  };
  new Function('require', 'exports', 'loadNativeModule', compiled.outputText)(
    requireKit, exported, () => native,
  );
  const adapter = new exported.OhosOpener();
  adapter.install(context, 'moke_lib');
  return {
    adapter, context, calls, replies,
    expire() { pending = false; },
    async dispatch(kind, value) {
      callback(JSON.stringify({ id: 7, kind, value }));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('native adapter dispatches links, dialer, mail and read-only file Wants', async () => {
  const harness = adapterHarness();
  await harness.dispatch('url', 'https://example.com');
  await harness.dispatch('url', 'tel:+123');
  await harness.dispatch('url', 'mailto:a@example.com');
  await harness.dispatch('path', '/storage/books/test.epub');
  assert.deepEqual(harness.calls, [
    ['link', 'https://example.com'],
    ['ability', { action: 'ohos.want.action.dial', uri: 'tel:+123' }],
    ['ability', { action: 'ohos.want.action.sendToData', uri: 'mailto:a@example.com' }],
    ['ability', { action: 'ohos.want.action.viewData', uri: 'file://app/storage/books/test.epub', type: 'application/epub+zip', flags: 1 }],
  ]);
  assert.deepEqual(harness.replies, Array.from({ length: 4 }, () => [7, null]));
});

test('native adapter acknowledges only after the OS promise settles and forwards rejection', async () => {
  const harness = adapterHarness();
  let reject;
  harness.context.openLink = () => new Promise((_resolve, fail) => { reject = fail; });
  await harness.dispatch('url', 'https://example.com');
  assert.deepEqual(harness.replies, []);
  reject({ code: 16000001, message: 'No matching Ability' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.replies, [[7, 'OHOS opener 16000001: No matching Ability']]);
});

test('native adapter ignores expired and destroyed-Ability requests', async () => {
  for (const dispose of [false, true]) {
    const harness = adapterHarness();
    if (dispose) harness.adapter.dispose();
    else harness.expire();
    await harness.dispatch('url', 'https://example.com');
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.replies, []);
  }
});

test('native adapter rejects unsupported protocols and request kinds', async () => {
  const harness = adapterHarness();
  await harness.dispatch('url', 'file:///private');
  await harness.dispatch('execute', 'sh');
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.replies.length, 2);
  assert.ok(harness.replies.every(([, error]) => error.includes('Unsupported')));
});
