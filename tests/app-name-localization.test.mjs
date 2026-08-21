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
} from '../scripts/prepare-mobile-app-names.mjs';
import { normalizeArtifactNames } from '../scripts/normalize-artifact-names.mjs';

const root = path.resolve(import.meta.dirname, '..');

function createIosFixture() {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const appleRoot = path.join(temporaryRoot, 'src-tauri', 'gen', 'apple');
  const appRoot = path.join(appleRoot, 'moke_iOS');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    path.join(appRoot, 'Info.plist'),
    '<plist><dict><key>CFBundleName</key><string>$(PRODUCT_NAME)</string></dict></plist>',
  );
  writeFileSync(path.join(appleRoot, 'project.yml'), 'name: moke\n');

  for (const locale of ['zh-Hans.lproj', 'zh-Hant.lproj']) {
    const sourceDir = path.join(temporaryRoot, 'src-tauri', 'mobile', 'ios', locale);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      path.join(sourceDir, 'InfoPlist.strings'),
      '"CFBundleDisplayName" = "墨客";\n"CFBundleName" = "墨客";\n',
    );
  }

  return { temporaryRoot, appleRoot };
}

function writeGeneratedXcodeProject(appleRoot, { includeResources = true } = {}) {
  const projectDir = path.join(appleRoot, 'moke.xcodeproj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'project.pbxproj'), `
PRODUCT_NAME = Moke;
/* Begin PBXBuildFile section */
${includeResources ? 'A1 /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = A2 /* InfoPlist.strings */; };' : ''}
/* End PBXBuildFile section */
/* Begin PBXFileReference section */
A3 /* zh-Hans */ = {isa = PBXFileReference; path = "zh-Hans.lproj/InfoPlist.strings"; };
A4 /* zh-Hant */ = {isa = PBXFileReference; path = "zh-Hant.lproj/InfoPlist.strings"; };
/* End PBXFileReference section */
/* Begin PBXVariantGroup section */
A2 /* InfoPlist.strings */ = {isa = PBXVariantGroup; children = (A3, A4); };
/* End PBXVariantGroup section */
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
    ['zh-Hans.lproj', 'zh-Hant.lproj'],
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

test('iOS 名称资源会进入实际生成的 Xcode Resources', () => {
  const { temporaryRoot, appleRoot } = createIosFixture();
  let command;

  prepareIosAppNames(temporaryRoot, (...args) => {
    command = args;
    writeGeneratedXcodeProject(appleRoot);
    return { status: 0 };
  });

  for (const locale of ['zh-Hans.lproj', 'zh-Hant.lproj']) {
    const generated = readFileSync(
      path.join(appleRoot, 'Sources', locale, 'InfoPlist.strings'),
      'utf8',
    );
    assert.match(generated, /"CFBundleDisplayName" = "墨客";/);
    assert.match(generated, /"CFBundleName" = "墨客";/);
  }
  assert.equal(command[0], 'xcodegen');
  assert.deepEqual(command[1], ['generate', '--no-env', '--spec', path.join(appleRoot, 'project.yml')]);
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
      writeGeneratedXcodeProject(appleRoot, { includeResources: false });
      return { status: 0 };
    }),
    /does not add InfoPlist\.strings to a Resources build phase/,
  );
});

test('iOS 发布构建安装仓库固定版本的 XcodeGen', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'build-release.yml'), 'utf8');
  const installStep = workflow.indexOf('Install pinned XcodeGen');
  const prepareStep = workflow.indexOf('Add localized iOS app names');

  assert.ok(installStep >= 0 && installStep < prepareStep);
  assert.match(workflow, /XCODEGEN_VERSION: 2\.46\.0/);
  assert.match(workflow, /XCODEGEN_SHA256: 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806/);
});
