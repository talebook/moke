import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareMobileIcons } from '../scripts/prepare-mobile-icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const icons = path.join(root, 'src-tauri/icons');
const androidResources = 'src-tauri/gen/android/app/src/main/res';
const ohosResources = [
  'src-tauri/gen/ohos/AppScope/resources/base/media',
  'src-tauri/gen/ohos/entry/src/main/resources/base/media',
];

function fixture(t) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'moke-icons-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  cpSync(icons, path.join(temporaryRoot, 'src-tauri/icons'), { recursive: true });
  return temporaryRoot;
}

function assertSameResources(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) assertSameResources(from, to);
    else assert.deepEqual(readFileSync(to), readFileSync(from), to);
  }
}

function pngSize(file) {
  const png = readFileSync(file);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('Android overlays committed icons verbatim and preserves names, themes and shortcuts', (t) => {
  const temporaryRoot = fixture(t);
  const resources = path.join(temporaryRoot, androidResources);
  for (const file of ['values/strings.xml', 'values/styles.xml', 'xml/shortcuts.xml']) {
    const target = path.join(resources, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'existing app resource');
  }
  const staleIcon = path.join(resources, 'mipmap-mdpi/ic_launcher.png');
  mkdirSync(path.dirname(staleIcon), { recursive: true });
  writeFileSync(staleIcon, 'default template icon');

  prepareMobileIcons('android', temporaryRoot);
  prepareMobileIcons('android', temporaryRoot);
  assertSameResources(path.join(icons, 'android'), resources);
  for (const file of ['values/strings.xml', 'values/styles.xml', 'xml/shortcuts.xml']) {
    assert.equal(readFileSync(path.join(resources, file), 'utf8'), 'existing app resource');
  }
});

test('OHOS replaces the layered and startup icons in both resource scopes', (t) => {
  const temporaryRoot = fixture(t);
  for (const resource of ohosResources) {
    const target = path.join(temporaryRoot, resource);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'foreground.png'), 'default template icon');
    writeFileSync(path.join(target, 'unrelated.svg'), 'existing media');
  }
  prepareMobileIcons('ohos', temporaryRoot);
  for (const resource of ohosResources) {
    const target = path.join(temporaryRoot, resource);
    assertSameResources(path.join(icons, 'ohos'), target);
    assert.equal(readFileSync(path.join(target, 'unrelated.svg'), 'utf8'), 'existing media');
  }
});

test('missing generated projects fail without creating a partial scaffold', (t) => {
  const temporaryRoot = fixture(t);
  assert.throws(() => prepareMobileIcons('android', temporaryRoot), /Initialize the android project/);
  assert.equal(existsSync(path.join(temporaryRoot, androidResources)), false);
  const appScope = path.join(temporaryRoot, ohosResources[0]);
  mkdirSync(appScope, { recursive: true });
  writeFileSync(path.join(appScope, 'foreground.png'), 'original');
  assert.throws(() => prepareMobileIcons('ohos', temporaryRoot), /Initialize the ohos project/);
  assert.equal(readFileSync(path.join(appScope, 'foreground.png'), 'utf8'), 'original');
  assert.throws(() => prepareMobileIcons('ios', temporaryRoot), /Unsupported icon platform/);
});

test('Android densities have distinct launcher and 108dp adaptive resources', () => {
  for (const [density, launcher, adaptive] of [
    ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
    ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
  ]) {
    const folder = path.join(icons, 'android', `mipmap-${density}`);
    for (const file of ['ic_launcher.png', 'ic_launcher_round.png']) {
      assert.deepEqual(pngSize(path.join(folder, file)), [launcher, launcher]);
    }
    for (const file of ['ic_launcher_foreground.png', 'ic_launcher_monochrome.png']) {
      assert.deepEqual(pngSize(path.join(folder, file)), [adaptive, adaptive]);
    }
  }
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const xml = readFileSync(path.join(icons, 'android/mipmap-anydpi-v33', `${name}.xml`), 'utf8');
    assert.match(xml, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"/);
    assert.doesNotMatch(xml, /inset/);
  }
  assert.deepEqual(pngSize(path.join(icons, 'ohos/foreground.png')), [1024, 1024]);
  assert.deepEqual(pngSize(path.join(icons, 'ohos/background.png')), [1024, 1024]);
  assert.deepEqual(pngSize(path.join(icons, 'ohos/startIcon.png')), [144, 144]);
});

test('release workflows copy mobile icons after init and never regenerate them', () => {
  for (const file of readdirSync(path.join(root, '.github/workflows'))) {
    const workflow = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.doesNotMatch(workflow, /\btauri\s+icon\b/, file);
  }
  const workflow = readFileSync(path.join(root, '.github/workflows/build-release.yml'), 'utf8');
  for (const platform of ['android', 'ohos']) {
    const init = workflow.indexOf(`tauri ${platform} init`);
    const copy = workflow.indexOf(`node scripts/prepare-mobile-icons.mjs ${platform}`);
    const build = workflow.indexOf(`tauri ${platform} build`);
    assert.ok(init >= 0 && init < copy && copy < build, platform);
  }
});
