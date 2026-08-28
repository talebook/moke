import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  prepareAndroidAppNames,
  prepareIosAppNames,
  verifyIosAppNames,
} from '../scripts/prepare-mobile-app-names.mjs';
import { normalizeArtifactNames } from '../scripts/normalize-artifact-names.mjs';

const root = path.resolve(import.meta.dirname, '..');
const iosFixtureLocales = new Map([
  ['en.lproj', 'Moke'],
  ['zh-Hans.lproj', '墨客'],
  ['zh-Hant.lproj', '墨客'],
]);

function writeInfoPlist(appRoot, {
  displayName,
  bundleName = '$(PRODUCT_NAME)',
} = {}) {
  const entries = [];
  if (displayName !== undefined) {
    entries.push(`<key>CFBundleDisplayName</key><string>${displayName}</string>`);
  }
  if (bundleName !== undefined) {
    entries.push(`<key>CFBundleName</key><string>${bundleName}</string>`);
  }
  writeFileSync(
    path.join(appRoot, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${entries.join('')}</dict></plist>`,
  );
}

function createIosFixture() {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const tauriRoot = path.join(temporaryRoot, 'src-tauri');
  const appleRoot = path.join(tauriRoot, 'gen', 'apple');
  const appRoot = path.join(appleRoot, 'moke_iOS');
  mkdirSync(appRoot, { recursive: true });
  writeInfoPlist(appRoot);
  writeFileSync(path.join(tauriRoot, 'tauri.conf.json'), '{"productName":"Moke"}\n');
  writeFileSync(path.join(appleRoot, 'project.yml'), 'name: moke\n');

  for (const [locale, appName] of iosFixtureLocales) {
    const sourceDir = path.join(tauriRoot, 'mobile', 'ios', locale);
    const staleDir = path.join(appRoot, locale);
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(
      path.join(sourceDir, 'InfoPlist.strings'),
      `"CFBundleDisplayName" = "${appName}";\n"CFBundleName" = "${appName}";\n`,
    );
    writeFileSync(path.join(staleDir, 'InfoPlist.strings'), 'stale\n');
  }

  return {
    temporaryRoot,
    appleRoot,
    appRoot,
  };
}

// This excerpt follows XcodeGen 2.46.0's serialized project structure and
// 24-character object IDs. The macOS CI job remains the integration test that
// runs the pinned binary against Tauri's complete generated project.
function writeXcodeGenProjectFixture(appleRoot, {
  includeResources = true,
  includeVariantGroup = true,
  productName = 'Moke',
} = {}) {
  const projectDir = path.join(appleRoot, 'moke.xcodeproj');
  mkdirSync(projectDir, { recursive: true });
  const buildFile = includeResources
    ? '\t\t111111111111111111111111 /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = 222222222222222222222222 /* InfoPlist.strings */; };'
    : '';
  const buildPhaseEntry = includeResources
    ? '\t\t\t\t111111111111111111111111 /* InfoPlist.strings in Resources */,'
    : '';
  const variantGroup = includeVariantGroup
    ? `\t\t222222222222222222222222 /* InfoPlist.strings */ = {
\t\t\tisa = PBXVariantGroup;
\t\t\tchildren = (
\t\t\t\t333333333333333333333333 /* en */,
\t\t\t\t444444444444444444444444 /* zh-Hans */,
\t\t\t\t555555555555555555555555 /* zh-Hant */,
\t\t\t);
\t\t\tname = InfoPlist.strings;
\t\t\tsourceTree = "<group>";
\t\t};`
    : '';

  writeFileSync(path.join(projectDir, 'project.pbxproj'), `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tobjects = {

/* Begin PBXBuildFile section */
${buildFile}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\t333333333333333333333333 /* en */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = en.lproj/InfoPlist.strings; sourceTree = "<group>"; };
\t\t444444444444444444444444 /* zh-Hans */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = "zh-Hans"; path = "zh-Hans.lproj/InfoPlist.strings"; sourceTree = "<group>"; };
\t\t555555555555555555555555 /* zh-Hant */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = "zh-Hant"; path = "zh-Hant.lproj/InfoPlist.strings"; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXResourcesBuildPhase section */
\t\t666666666666666666666666 /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${buildPhaseEntry}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXVariantGroup section */
${variantGroup}
/* End PBXVariantGroup section */

/* Begin XCBuildConfiguration section */
\t\t777777777777777777777777 /* release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_NAME = "${productName}";
\t\t\t};
\t\t\tname = release;
\t\t};
/* End XCBuildConfiguration section */
\t};
}
`);
}

test('默认软件包名称与桌面平台产品名保持 Moke', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const windowsConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.windows.conf.json'), 'utf8'));
  const macosConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.macos.conf.json'), 'utf8'));
  const linuxConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.linux.conf.json'), 'utf8'));
  const ohosConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.ohos.conf.json'), 'utf8'));

  assert.equal(config.productName, 'Moke');
  assert.equal(config.app.windows[0].title, '墨客');
  assert.equal(windowsConfig.productName, 'Moke');
  assert.equal(windowsConfig.app.windows[0].title, 'Moke');
  assert.equal(macosConfig.productName, 'Moke');
  assert.equal(macosConfig.app.windows[0].title, 'Moke');
  assert.equal(
    macosConfig.bundle.resources['macos/zh-Hans.lproj/InfoPlist.strings'],
    'zh-Hans.lproj/InfoPlist.strings',
  );
  assert.equal(
    macosConfig.bundle.resources['macos/zh-Hant.lproj/InfoPlist.strings'],
    'zh-Hant.lproj/InfoPlist.strings',
  );
  assert.equal(linuxConfig.productName, 'Moke');
  assert.equal(linuxConfig.app.windows[0].title, 'Moke');
  assert.equal(linuxConfig.bundle.linux.deb.desktopTemplate, 'linux/moke.desktop.hbs');
  assert.equal(linuxConfig.bundle.linux.rpm.desktopTemplate, 'linux/moke.desktop.hbs');
  assert.equal(ohosConfig.productName, 'Moke');
  assert.equal(config.bundle.windows.wix.upgradeCode, 'd1dfe239-c6ec-5195-980b-2d6cd723458a');
  assert.equal(config.bundle.windows.wix.language, undefined);
});

test('上传前将产物文件名中的墨客替换为小写 moke', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-artifact-name-'));
  const bundleRoot = path.join(temporaryRoot, 'artifacts');
  mkdirSync(bundleRoot, { recursive: true });
  writeFileSync(path.join(bundleRoot, '墨客_1.0.2_x64.dmg'), 'artifact');
  writeFileSync(path.join(bundleRoot, 'Moke_1.0.2_x64.AppImage'), 'artifact');

  const renamed = normalizeArtifactNames(temporaryRoot, ['artifacts']);

  assert.equal(renamed.length, 1);
  assert.equal(readFileSync(path.join(bundleRoot, 'moke_1.0.2_x64.dmg'), 'utf8'), 'artifact');
  assert.equal(readFileSync(path.join(bundleRoot, 'Moke_1.0.2_x64.AppImage'), 'utf8'), 'artifact');
});

test('macOS、Linux 与移动端仅在中文系统显示墨客，其他语言回退为 Moke', () => {
  const macosChinese = readFileSync(
    path.join(root, 'src-tauri', 'macos', 'zh-Hans.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const macosTraditionalChinese = readFileSync(
    path.join(root, 'src-tauri', 'macos', 'zh-Hant.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const linuxDesktop = readFileSync(
    path.join(root, 'src-tauri', 'linux', 'moke.desktop.hbs'),
    'utf8',
  );
  const iosEnglish = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'ios', 'en.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const iosChinese = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'ios', 'zh-Hans.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const iosTraditionalChinese = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'ios', 'zh-Hant.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const androidDefault = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'android', 'values', 'strings.xml'),
    'utf8',
  );
  const androidChinese = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'android', 'values-zh', 'strings.xml'),
    'utf8',
  );

  assert.match(macosChinese, /"CFBundleDisplayName" = "墨客";/);
  assert.match(macosTraditionalChinese, /"CFBundleDisplayName" = "墨客";/);
  assert.match(linuxDesktop, /^Name=\{\{name\}\}$/m);
  assert.match(linuxDesktop, /^Name\[zh\]=墨客$/m);
  assert.match(linuxDesktop, /^Name\[zh_CN\]=墨客$/m);
  assert.match(linuxDesktop, /^Name\[zh_TW\]=墨客$/m);
  assert.equal(existsSync(path.join(root, 'src-tauri', 'Info.ios.plist')), false);
  assert.match(iosEnglish, /"CFBundleDisplayName" = "Moke";/);
  assert.match(iosEnglish, /"CFBundleName" = "Moke";/);
  assert.match(iosChinese, /"CFBundleDisplayName" = "墨客";/);
  assert.match(iosTraditionalChinese, /"CFBundleDisplayName" = "墨客";/);
  assert.match(androidDefault, /<string name="app_name">Moke<\/string>/);
  assert.match(androidDefault, /<string name="main_activity_title">Moke<\/string>/);
  assert.match(androidChinese, /<string name="app_name">墨客<\/string>/);
  assert.deepEqual(
    readdirSync(path.join(root, 'src-tauri', 'mobile', 'android'))
      .filter((locale) => existsSync(
        path.join(root, 'src-tauri', 'mobile', 'android', locale, 'strings.xml'),
      ))
      .sort(),
    ['values', 'values-zh'],
  );
  assert.deepEqual(
    readdirSync(path.join(root, 'src-tauri', 'mobile', 'ios'))
      .filter((locale) => existsSync(
        path.join(root, 'src-tauri', 'mobile', 'ios', locale, 'InfoPlist.strings'),
      ))
      .sort(),
    ['en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj'],
  );
});

test('Android 默认与中文名称资源会复制到生成项目', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const sourceRoot = path.join(temporaryRoot, 'src-tauri', 'mobile', 'android');
  mkdirSync(path.join(sourceRoot, 'values'), { recursive: true });
  mkdirSync(path.join(sourceRoot, 'values-zh'), { recursive: true });
  writeFileSync(
    path.join(sourceRoot, 'values', 'strings.xml'),
    '<resources><string name="app_name">Moke</string></resources>',
  );
  writeFileSync(
    path.join(sourceRoot, 'values-zh', 'strings.xml'),
    '<resources><string name="app_name">墨客</string></resources>',
  );

  prepareAndroidAppNames(temporaryRoot);

  const generatedDefault = readFileSync(
    path.join(temporaryRoot, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
    'utf8',
  );
  const generatedChinese = readFileSync(
    path.join(temporaryRoot, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values-zh', 'strings.xml'),
    'utf8',
  );
  assert.match(generatedDefault, />Moke</);
  assert.match(generatedChinese, />墨客</);
});

test('iOS 名称资源会复制并验证 XcodeGen Resources 接线', () => {
  const { temporaryRoot, appleRoot, appRoot } = createIosFixture();
  let command;

  prepareIosAppNames(temporaryRoot, (...args) => {
    command = args;
    writeXcodeGenProjectFixture(appleRoot);
    return { status: 0 };
  });

  for (const [locale, appName] of iosFixtureLocales) {
    const generated = readFileSync(
      path.join(appleRoot, 'Sources', locale, 'InfoPlist.strings'),
      'utf8',
    );
    assert.equal(
      generated,
      `"CFBundleDisplayName" = "${appName}";\n"CFBundleName" = "${appName}";\n`,
    );
    assert.equal(existsSync(path.join(appRoot, locale)), false);
  }
  assert.equal(command[0], 'xcodegen');
  assert.deepEqual(command[1], ['generate', '--spec', path.join(appleRoot, 'project.yml')]);
  assert.deepEqual(command[2], { cwd: appleRoot, stdio: 'inherit' });
});

test('iOS 默认显示名优先使用 CFBundleDisplayName，缺失时回退 CFBundleName', () => {
  const { temporaryRoot, appleRoot, appRoot } = createIosFixture();
  prepareIosAppNames(temporaryRoot, () => {
    writeXcodeGenProjectFixture(appleRoot);
    return { status: 0 };
  });

  writeInfoPlist(appRoot, { displayName: 'Moke', bundleName: 'Wrong' });
  assert.doesNotThrow(() => verifyIosAppNames(temporaryRoot));

  writeInfoPlist(appRoot, { displayName: '$(PRODUCT_NAME)', bundleName: 'Wrong' });
  assert.doesNotThrow(() => verifyIosAppNames(temporaryRoot));

  writeInfoPlist(appRoot, { displayName: 'Wrong', bundleName: '$(PRODUCT_NAME)' });
  assert.throws(
    () => verifyIosAppNames(temporaryRoot),
    /does not resolve CFBundleDisplayName to Moke/,
  );

  writeInfoPlist(appRoot);
  assert.doesNotThrow(() => verifyIosAppNames(temporaryRoot));
});

test('iOS prepare 在 XcodeGen 不可用时失败', () => {
  const { temporaryRoot } = createIosFixture();
  const error = Object.assign(new Error('spawn xcodegen ENOENT'), { code: 'ENOENT' });

  assert.throws(
    () => prepareIosAppNames(temporaryRoot, () => ({ error, status: null })),
    /XcodeGen is required/,
  );
});

test('iOS prepare 在本地化资源未进入 Xcode Resources 时失败', () => {
  const { temporaryRoot, appleRoot } = createIosFixture();

  assert.throws(
    () => prepareIosAppNames(temporaryRoot, () => {
      writeXcodeGenProjectFixture(appleRoot, { includeResources: false });
      return { status: 0 };
    }),
    /does not add InfoPlist\.strings to a Resources build phase/,
  );
});

test('iOS prepare 在 XcodeGen 未生成本地化资源组时失败', () => {
  const { temporaryRoot, appleRoot } = createIosFixture();

  assert.throws(
    () => prepareIosAppNames(temporaryRoot, () => {
      writeXcodeGenProjectFixture(appleRoot, { includeVariantGroup: false });
      return { status: 0 };
    }),
    /does not define InfoPlist\.strings as a localized variant group/,
  );
});

test('iOS 发布构建安装仓库固定版本的 XcodeGen', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'build-release.yml'), 'utf8');
  const installStep = workflow.indexOf('Install pinned XcodeGen');
  const prepareStep = workflow.indexOf('Add localized iOS app names');

  assert.ok(installStep >= 0 && installStep < prepareStep);
  assert.match(workflow, /XCODEGEN_VERSION: 2\.46\.0/);
  assert.match(workflow, /XCODEGEN_SHA256: 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806/);
  assert.match(workflow, /PREFIX="\$PREFIX" "\$EXTRACT_DIR\/xcodegen\/install\.sh"/);
  assert.match(workflow, /trap 'rm -f "\$ARCHIVE"; rm -rf "\$EXTRACT_DIR"' EXIT/);
});
