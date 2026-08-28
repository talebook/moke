import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  findPackageDir,
  packageRootsFor,
  prepareOhos,
} from '../scripts/ohos-prepare-core.mjs';

const patchDir = fileURLToPath(new URL('../scripts/ohos-ability-patch', import.meta.url));
const toPosixPath = (value) => value.replaceAll('\\', '/');

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
