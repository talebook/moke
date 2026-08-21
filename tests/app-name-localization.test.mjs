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
  const iosDefault = readFileSync(path.join(root, 'src-tauri', 'Info.ios.plist'), 'utf8');
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
  assert.match(iosDefault, /<string>Moke<\/string>/);
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

test('iOS 中文名称资源会复制并重新生成 Xcode 项目', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const sourceDir = path.join(temporaryRoot, 'src-tauri', 'mobile', 'ios', 'zh-Hans.lproj');
  const appleRoot = path.join(temporaryRoot, 'src-tauri', 'gen', 'apple');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(path.join(appleRoot, 'moke_iOS'), { recursive: true });
  writeFileSync(path.join(sourceDir, 'InfoPlist.strings'), '"CFBundleDisplayName" = "墨客";\n');
  writeFileSync(path.join(appleRoot, 'project.yml'), 'name: moke\n');

  let command;
  prepareIosAppNames(temporaryRoot, (...args) => {
    command = args;
    return { status: 0 };
  });

  const generated = readFileSync(
    path.join(appleRoot, 'moke_iOS', 'zh-Hans.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  assert.match(generated, /墨客/);
  assert.equal(command[0], 'xcodegen');
  assert.deepEqual(command[1], ['generate', '--spec', path.join(appleRoot, 'project.yml')]);
});
