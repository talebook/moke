import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PATCH_FILES,
  applyPatchesToPackage,
  ensureDomStorage,
  ensureWindowsHvigorCli,
  findPackageDir,
  packageRootsFor,
  prepareOhos,
} from '../scripts/ohos-prepare-core.mjs';

const patchDir = fileURLToPath(new URL('../scripts/ohos-ability-patch', import.meta.url));
const toPosixPath = (value) => value.replaceAll('\\', '/');
const gitmodules = readFileSync(new URL('../.gitmodules', import.meta.url), 'utf8');
const tauriManifest = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/build-release.yml', import.meta.url),
  'utf8',
);

const UNPATCHED_MAIN_PAGE = `@Entry({ routeName: "RustAbility" })
@Component
struct Index {
  build() { Row() { Column() {} }.height("100%"); }
}
`;

const UNPATCHED_DEFAULT_WEBVIEW = `@Builder
function WebBuilder(data: WebviewNodeData) {
  Web({ src: "", controller: data.controller })
    .width("100%")
    .javaScriptAccess(data?.javascriptEnable)
    .onControllerAttached(() => {});
}
`;

test('Windows OHOS preparation fixes the generated Hvigor CLI path', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-hvigor-'));
  try {
    const entry = join(root, 'entry');
    mkdirSync(entry);
    const hvigorPath = join(entry, 'hvigorfile.ts');
    writeFileSync(hvigorPath, 'execFileSync(`vendor/tauri/target/debug/cargo-tauri`, ["tauri"]);\n');
    assert.equal(ensureWindowsHvigorCli(root, 'win32'), 'patched');
    assert.match(readFileSync(hvigorPath, 'utf8'), /execFileSync\(resolve\(__dirname, "\.\.\/\.\.\/\.\.\/\.\.\/vendor\/tauri\/target\/debug\/cargo-tauri\.exe"\)/);
    assert.equal(ensureWindowsHvigorCli(root, 'win32'), 'already-present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OHOS 统一使用官方 Tauri 分支与官方模板图标', () => {
  const tauriSubmodule = gitmodules.match(
    /\[submodule "tauri"\]([\s\S]*?)(?=\n\[submodule |$)/,
  )?.[1];
  assert.ok(tauriSubmodule, 'vendor/tauri submodule configuration is missing');
  assert.match(tauriSubmodule, /url = https:\/\/github\.com\/tauri-apps\/tauri\.git/);
  assert.match(tauriSubmodule, /branch = feat\/open-harmony/);
  assert.doesNotMatch(tauriSubmodule, /hehetoshang\/tauri|branch = dev/);

  for (const crate of [
    'tauri',
    'tauri-build',
    'tauri-codegen',
    'tauri-macros',
    'tauri-plugin',
    'tauri-runtime',
    'tauri-runtime-wry',
    'tauri-utils',
  ]) {
    assert.match(
      tauriManifest,
      new RegExp(`${crate} = \\{ path = "\\.\\.\\/vendor\\/tauri\\/crates\\/${crate}"`),
      `${crate} must resolve through vendor/tauri`,
    );
  }

  assert.doesNotMatch(releaseWorkflow, /Generate OpenHarmony launcher icons/);
  for (const path of [
    'AppScope/resources/base/media/background.png',
    'AppScope/resources/base/media/foreground.png',
    'AppScope/resources/base/media/layered_image.json',
    'entry/src/main/resources/base/media/background.png',
    'entry/src/main/resources/base/media/foreground.png',
    'entry/src/main/resources/base/media/layered_image.json',
    'entry/src/main/resources/base/media/startIcon.png',
  ]) {
    assert.ok(
      existsSync(new URL(`../vendor/tauri/crates/tauri-cli/templates/mobile/open-harmony/${path}`, import.meta.url)),
      `official OpenHarmony template icon is missing: ${path}`,
    );
  }
});

function makeFakePackage(ohosRoot, roots) {
  for (const root of roots) {
    const etsDir = join(ohosRoot, root, '@ohos-rs', 'ability', 'src', 'main', 'ets');
    mkdirSync(join(etsDir, 'webview'), { recursive: true });
    mkdirSync(join(etsDir, 'components'), { recursive: true });
    writeFileSync(join(etsDir, 'webview', 'DefaultWebview.ets'), UNPATCHED_DEFAULT_WEBVIEW);
    writeFileSync(
      join(etsDir, 'webview', 'Utils.ets'),
      'export interface JsHelper { getUrl: () => string; }\n',
    );
    writeFileSync(
      join(etsDir, 'components', 'DefaultXComponent.ets'),
      '@Component\nexport struct DefaultXComponent {}\n',
    );
    writeFileSync(join(etsDir, 'components', 'MainPage.ets'), UNPATCHED_MAIN_PAGE);
  }
}

test('packageRootsFor 搜索顺序优先 entry/oh_modules（与 CI 断言一致）', () => {
  assert.deepEqual(packageRootsFor('/gen/ohos').map(toPosixPath), [
    '/gen/ohos/entry/oh_modules',
    '/gen/ohos/oh_modules',
  ]);
});

test('findPackageDir 按 scoped 目录段定位 @ohos-rs/ability，缺失返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-prepare-'));
  try {
    assert.equal(findPackageDir(join(root, 'oh_modules'), '@ohos-rs/ability'), null);
    makeFakePackage(root, ['oh_modules']);
    assert.equal(
      findPackageDir(join(root, 'oh_modules'), '@ohos-rs/ability'),
      join(root, 'oh_modules', '@ohos-rs', 'ability'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareOhos 把 4 个补丁落到 entry/oh_modules，产物含 back-key 与 domStorageAccess', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-prepare-'));
  try {
    makeFakePackage(root, ['entry/oh_modules']);
    const { results } = prepareOhos({ ohosRoot: root, patchDir });
    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(
      result.abilityDir,
      join(root, 'entry', 'oh_modules', '@ohos-rs', 'ability'),
    );
    assert.equal(result.patches.applied.length, 4);
    assert.deepEqual(result.patches.failed, []);
    const mainPage = readFileSync(
      join(result.abilityDir, 'src', 'main', 'ets', 'components', 'MainPage.ets'),
      'utf8',
    );
    assert.ok(mainPage.includes('onBackPress'));
    assert.ok(mainPage.includes('backwardIfPossible'));
    const webview = readFileSync(
      join(result.abilityDir, 'src', 'main', 'ets', 'webview', 'DefaultWebview.ets'),
      'utf8',
    );
    assert.ok(webview.includes('domStorageAccess(true)'));
    assert.ok(webview.includes('backwardIfPossible'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareOhos 两个候选位置都存在时都打补丁', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-prepare-'));
  try {
    makeFakePackage(root, ['entry/oh_modules', 'oh_modules']);
    const { results } = prepareOhos({ ohosRoot: root, patchDir });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.patches.applied.length, 4);
      const mainPage = readFileSync(
        join(result.abilityDir, 'src', 'main', 'ets', 'components', 'MainPage.ets'),
        'utf8',
      );
      assert.ok(mainPage.includes('onBackPress'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyPatchesToPackage 目标缺失时返回失败列表（供 CLI 硬失败）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-prepare-'));
  try {
    makeFakePackage(root, ['entry/oh_modules']);
    const abilityDir = join(root, 'entry', 'oh_modules', '@ohos-rs', 'ability');
    rmSync(join(abilityDir, 'src', 'main', 'ets', 'webview', 'Utils.ets'));
    const { applied, failed } = applyPatchesToPackage(abilityDir, patchDir, DEFAULT_PATCH_FILES);
    assert.equal(applied.length, 3);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes('Utils.ets'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDomStorage 基于 abilityDir 定位，仅在内容确实变化时写盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'ohos-prepare-'));
  try {
    const abilityDir = join(root, 'oh_modules', '@ohos-rs', 'ability');
    const webviewPath = join(abilityDir, 'src', 'main', 'ets', 'webview', 'DefaultWebview.ets');

    assert.equal(ensureDomStorage(abilityDir).status, 'missing');

    mkdirSync(join(abilityDir, 'src', 'main', 'ets', 'webview'), { recursive: true });
    writeFileSync(webviewPath, UNPATCHED_DEFAULT_WEBVIEW);
    assert.equal(ensureDomStorage(abilityDir).status, 'patched');
    assert.ok(readFileSync(webviewPath, 'utf8').includes('domStorageAccess'));

    assert.equal(ensureDomStorage(abilityDir).status, 'already-present');
    const before = readFileSync(webviewPath, 'utf8');
    ensureDomStorage(abilityDir);
    assert.equal(readFileSync(webviewPath, 'utf8'), before);

    writeFileSync(webviewPath, '@Builder\nfunction WebBuilder() {}\n');
    assert.equal(ensureDomStorage(abilityDir).status, 'no-anchor');
    assert.equal(readFileSync(webviewPath, 'utf8'), '@Builder\nfunction WebBuilder() {}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
