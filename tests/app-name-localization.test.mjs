import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  prepareAndroidAppNames,
  prepareIosAppNames,
} from '../scripts/prepare-mobile-app-names.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('桌面默认名称为墨客，OHOS 保持 Moke', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const ohosConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.ohos.conf.json'), 'utf8'));

  assert.equal(config.productName, '墨客');
  assert.equal(config.app.windows[0].title, '墨客');
  assert.equal(ohosConfig.productName, 'Moke');
  assert.equal(config.bundle.windows.wix.upgradeCode, 'd1dfe239-c6ec-5195-980b-2d6cd723458a');
});

test('移动端默认名称为墨客，英文系统名称为 Moke', () => {
  const iosDefault = readFileSync(path.join(root, 'src-tauri', 'Info.ios.plist'), 'utf8');
  const iosEnglish = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'ios', 'en.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  const androidEnglish = readFileSync(
    path.join(root, 'src-tauri', 'mobile', 'android', 'values-en', 'strings.xml'),
    'utf8',
  );

  assert.match(iosDefault, /<string>墨客<\/string>/);
  assert.match(iosEnglish, /"CFBundleDisplayName" = "Moke";/);
  assert.match(androidEnglish, /<string name="app_name">Moke<\/string>/);
  assert.match(androidEnglish, /<string name="main_activity_title">Moke<\/string>/);
});

test('Android 英文名称资源会复制到生成项目', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const sourceDir = path.join(temporaryRoot, 'src-tauri', 'mobile', 'android', 'values-en');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'strings.xml'), '<resources><string name="app_name">Moke</string></resources>');

  prepareAndroidAppNames(temporaryRoot);

  const generated = readFileSync(
    path.join(temporaryRoot, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values-en', 'strings.xml'),
    'utf8',
  );
  assert.match(generated, />Moke</);
});

test('iOS 英文名称资源会复制并重新生成 Xcode 项目', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-app-name-'));
  const sourceDir = path.join(temporaryRoot, 'src-tauri', 'mobile', 'ios', 'en.lproj');
  const appleRoot = path.join(temporaryRoot, 'src-tauri', 'gen', 'apple');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(path.join(appleRoot, 'moke_iOS'), { recursive: true });
  writeFileSync(path.join(sourceDir, 'InfoPlist.strings'), '"CFBundleDisplayName" = "Moke";\n');
  writeFileSync(path.join(appleRoot, 'project.yml'), 'name: moke\n');

  let command;
  prepareIosAppNames(temporaryRoot, (...args) => {
    command = args;
    return { status: 0 };
  });

  const generated = readFileSync(
    path.join(appleRoot, 'moke_iOS', 'en.lproj', 'InfoPlist.strings'),
    'utf8',
  );
  assert.match(generated, /Moke/);
  assert.equal(command[0], 'xcodegen');
  assert.deepEqual(command[1], ['generate', '--spec', path.join(appleRoot, 'project.yml')]);
});
