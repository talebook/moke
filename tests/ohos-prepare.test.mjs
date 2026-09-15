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
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

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

test('RustAbility passes the real sandbox context before native startup', async () => {
  const source = readFileSync(join(patchDir, 'ability', 'RustAbility.ets'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const events = [];
  let receivedContext;
  const nativeModule = {
    registerCustomProtocol: () => events.push('protocol'),
    init: (context) => {
      receivedContext = context;
      events.push('init');
      return { windowStageEventCallback: { onAbilityCreate: () => events.push('create') } };
    },
  };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    AppStorage: { setOrCreate() {} },
    require: (name) => {
      switch (name) {
        case '@kit.AbilityKit': return { UIAbility: class {} };
        case '@ohos.web.webview':
          return { default: { WebviewController: { initializeWebEngine: () => events.push('engine') } } };
        case '../helper/loadable': return { Loadable: { load: async () => nativeModule } };
        case '../components/MainPage': return { RouteName: 'RustAbility' };
        default: throw new Error(`Unexpected runtime import: ${name}`);
      }
    },
  });
  const ability = new exports.RustAbility();
  const resourceManager = {};
  ability.moduleName = 'moke_lib';
  ability.context = {
    filesDir: '/data/storage/el2/base/haps/entry/files',
    config: { language: 'zh-CN' },
    resourceManager,
  };
  await ability.onCreate({}, {});
  assert.equal(receivedContext.basePath, ability.context.filesDir);
  assert.equal(receivedContext.prefPath, ability.context.filesDir);
  assert.equal(receivedContext.moduleName, 'moke_lib');
  assert.equal(receivedContext.preferredLocales, 'zh-CN');
  assert.equal(receivedContext.resourceManager, resourceManager);
  assert.deepEqual(events, ['protocol', 'engine', 'init', 'create']);
});

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
    mkdirSync(join(etsDir, 'ability'), { recursive: true });
    writeFileSync(join(etsDir, 'ability', 'RustAbility.ets'), 'export class RustAbility {}\n');
    writeFileSync(join(etsDir, 'ability', 'type.ets'), 'export interface Module {}\n');
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

test('prepareOhos 把 6 个补丁落到 entry/oh_modules，产物含 back-key 与 domStorageAccess', () => {
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
    assert.equal(result.patches.applied.length, 6);
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
      assert.equal(result.patches.applied.length, 6);
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
    assert.equal(applied.length, 5);
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
