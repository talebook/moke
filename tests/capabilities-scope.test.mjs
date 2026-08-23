import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTION_CAPABILITY_FILES = [
  'src-tauri/capabilities/default.json',
  'src-tauri/capabilities/reader.json',
  'src-tauri/capabilities/reader-mobile.json',
  'src-tauri/capabilities/ohos.json',
];
const DEV_OHOS_CAPABILITY = 'src-tauri/capabilities-dev/ohos.json';
const ALL_CAPABILITY_FILES = [...PRODUCTION_CAPABILITY_FILES, DEV_OHOS_CAPABILITY];

function readCapability(file) {
  return JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
}

function readTauriConfig() {
  return JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
}

function permissionIdentifier(permission) {
  return typeof permission === 'string' ? permission : permission.identifier ?? '';
}

function findPermission(capability, identifier) {
  return capability.permissions.find(
    (permission) => permissionIdentifier(permission) === identifier,
  );
}

function permissionPaths(permission) {
  if (!permission || typeof permission === 'string') return [];
  return (permission.allow ?? [])
    .map((entry) => entry?.path)
    .filter((path) => typeof path === 'string');
}

function collectFsOpenerAllowEntries(capability) {
  const entries = [];
  for (const permission of capability.permissions) {
    if (typeof permission === 'string') continue;
    const identifier = permissionIdentifier(permission);
    if (!identifier.startsWith('fs:') && !identifier.startsWith('opener:')) continue;
    for (const path of permissionPaths(permission)) {
      entries.push({ identifier, path });
    }
  }
  return entries;
}

const PRIVATE_BASES = ['$APPDATA', '$APPCONFIG', '$APPCACHE', '$APPLOG', '$TEMP'];

function hasParentDirTraversal(path) {
  return path.split(/[\\/]/).includes('..');
}

function isRestrictedToPrivateDirs(path) {
  if (hasParentDirTraversal(path)) return false;
  return PRIVATE_BASES.some(
    (prefix) => path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`),
  );
}

for (const file of ALL_CAPABILITY_FILES) {
  test(`${file} fs/opener allow entries stay inside app-private or temp directories`, () => {
    const offenders = collectFsOpenerAllowEntries(readCapability(file))
      .filter(({ path }) => !isRestrictedToPrivateDirs(path))
      .map(({ identifier, path }) => `${identifier}: ${path}`);
    assert.deepEqual(offenders, []);
  });

  test(`${file} does not grant an app-directory root`, () => {
    const offenders = collectFsOpenerAllowEntries(readCapability(file))
      .filter(({ path }) => PRIVATE_BASES.includes(path))
      .map(({ identifier, path }) => `${identifier}: ${path}`);
    assert.deepEqual(offenders, []);
  });
}

test('production capabilities are split by host, desktop reader, and mobile reader windows', () => {
  const main = readCapability('src-tauri/capabilities/default.json');
  const reader = readCapability('src-tauri/capabilities/reader.json');
  const mobileReader = readCapability('src-tauri/capabilities/reader-mobile.json');
  const ohos = readCapability('src-tauri/capabilities/ohos.json');

  assert.deepEqual(main.windows, ['main']);
  assert.deepEqual(reader.windows, ['reader-*', 'moke-home-*']);
  assert.deepEqual(reader.platforms, ['linux', 'macOS', 'windows']);
  assert.deepEqual(mobileReader.windows, ['main']);
  assert.deepEqual(mobileReader.platforms, ['android', 'iOS']);
  assert.deepEqual(ohos.windows, ['main']);
  assert.deepEqual(ohos.platforms, ['openHarmony']);

  for (const capability of [main, reader, mobileReader, ohos]) {
    assert.ok(!capability.windows.includes('*'));
  }
});

test('desktop fs write paths stay command-scoped instead of entering the plugin global scope', () => {
  const manifests = JSON.parse(
    readFileSync(join(repoRoot, 'src-tauri/gen/schemas/acl-manifests.json'), 'utf8'),
  );
  const fsPermissions = manifests.fs.permissions;

  assert.ok(fsPermissions['write-all'].commands.allow.includes('write'));
  assert.ok(fsPermissions['write-all'].commands.allow.includes('remove'));
  assert.deepEqual(fsPermissions.scope.commands.allow, []);
  assert.deepEqual(fsPermissions.scope.commands.deny, []);

  for (const file of [
    'src-tauri/capabilities/default.json',
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const identifiers = readCapability(file).permissions.map(permissionIdentifier);
    assert.ok(!identifiers.includes('fs:scope'), `${file} must not broaden the fs global scope`);
  }
});

test('base Tauri config activates only host and reader capabilities', () => {
  assert.deepEqual(readTauriConfig().app.security.capabilities, [
    'default',
    'reader',
    'reader-mobile',
  ]);
  assert.ok(
    !readTauriConfig().app.security.capabilities.includes('ohos'),
    'the broad single-WebView OHOS capability must not merge into desktop main',
  );
});

test('desktop and mobile reader variants grant the same reader operations', () => {
  const desktop = readCapability('src-tauri/capabilities/reader.json');
  const mobile = readCapability('src-tauri/capabilities/reader-mobile.json');
  assert.deepEqual(mobile.permissions, desktop.permissions);
});

test('embedded reader windows can update their native window title', () => {
  for (const file of [
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
    'src-tauri/capabilities/ohos.json',
  ]) {
    const capability = readCapability(file);
    assert.ok(
      capability.permissions.includes('core:window:allow-set-title'),
      `${file} must allow Readest to update the active book title`,
    );
  }
});

test('main window does not inherit reader-only plugins', () => {
  const main = readCapability('src-tauri/capabilities/default.json');
  const identifiers = new Set(main.permissions.map(permissionIdentifier));
  for (const readerOnly of [
    'dialog:default',
    'clipboard-manager:allow-write-text',
    'clipboard-manager:allow-read-text',
    'device-info:default',
    'turso:default',
    'native-tts:default',
    'native-bridge:default',
    'websocket:default',
  ]) {
    assert.ok(!identifiers.has(readerOnly), `main must not grant ${readerOnly}`);
  }
});

test('reader windows can read Moke books but cannot write the books directory', () => {
  for (const file of [
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const capability = readCapability(file);
    const readPaths = permissionPaths(findPermission(capability, 'fs:read-files'));
    const readDirPaths = permissionPaths(findPermission(capability, 'fs:read-dirs'));
    const writePaths = permissionPaths(findPermission(capability, 'fs:write-all'));

    assert.ok(readPaths.includes('$APPDATA/books/**'));
    assert.ok(readDirPaths.includes('$APPDATA/books'));
    assert.ok(writePaths.length > 0, 'Readest must retain its private settings/cache writes');
    assert.ok(
      writePaths.every((path) => !path.startsWith('$APPDATA/books')),
      `${file} must keep Moke books read-only`,
    );
  }
});

test('reader startup can inspect scoped paths and create app-private base directories', () => {
  const manifests = JSON.parse(
    readFileSync(join(repoRoot, 'src-tauri/gen/schemas/acl-manifests.json'), 'utf8'),
  );
  const fsPermissions = manifests.fs.permissions;

  assert.ok(fsPermissions['read-dirs'].commands.allow.includes('exists'));
  assert.ok(fsPermissions['read-dirs'].commands.allow.includes('read_dir'));
  assert.ok(fsPermissions['create-app-specific-dirs'].commands.allow.includes('mkdir'));
  assert.ok(!fsPermissions['create-app-specific-dirs'].commands.allow.includes('write_file'));
  assert.ok(!fsPermissions['create-app-specific-dirs'].commands.allow.includes('remove'));

  for (const file of [
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const capability = readCapability(file);
    const identifiers = new Set(capability.permissions.map(permissionIdentifier));
    const metadataPaths = permissionPaths(findPermission(capability, 'fs:read-dirs'));

    assert.ok(identifiers.has('fs:create-app-specific-dirs'));
    assert.ok(metadataPaths.includes('$APPCONFIG/settings.json'));
    assert.ok(metadataPaths.includes('$APPDATA/Readest'));
    assert.ok(metadataPaths.includes('$APPDATA/Readest/**'));
  }
});

test('reader capabilities preserve settings, RSS, and updater operations', () => {
  const privateFiles = [
    '$APPCONFIG/settings.json',
    '$APPCONFIG/settings.json.bak',
    '$APPCONFIG/feeds.json',
    '$APPCONFIG/feeds.json.bak',
  ];

  for (const file of [
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const capability = readCapability(file);
    const readPaths = permissionPaths(findPermission(capability, 'fs:read-files'));
    const writePaths = permissionPaths(findPermission(capability, 'fs:write-all'));
    for (const path of privateFiles) {
      assert.ok(readPaths.includes(path), `${file} must read ${path}`);
      assert.ok(writePaths.includes(path), `${file} must write ${path}`);
    }
    assert.ok(capability.permissions.includes('updater:default'));
    for (const unusedPermission of [
      'clipboard-manager:allow-read-text',
      'core:window:allow-center',
      'core:window:allow-hide',
    ]) {
      assert.ok(!capability.permissions.includes(unusedPermission));
    }
  }
});

test('main filesystem writes are limited to downloaded books', () => {
  const main = readCapability('src-tauri/capabilities/default.json');
  const writePermissions = new Set([
    'fs:allow-mkdir',
    'fs:allow-open',
    'fs:allow-write',
    'fs:allow-remove',
  ]);
  const paths = main.permissions
    .filter((permission) => writePermissions.has(permissionIdentifier(permission)))
    .flatMap(permissionPaths);

  assert.ok(paths.length > 0);
  assert.ok(paths.every((path) => path === '$APPDATA/books' || path.startsWith('$APPDATA/books/')));
});

test('main download lifecycle grants scoped stat and atomic rename operations', () => {
  const main = readCapability('src-tauri/capabilities/default.json');
  for (const identifier of ['fs:allow-stat', 'fs:allow-rename']) {
    const paths = permissionPaths(findPermission(main, identifier));
    assert.deepEqual(paths, ['$APPDATA/books/**']);
  }
  const identifiers = new Set(main.permissions.map(permissionIdentifier));
  for (const identifier of ['fs:allow-read', 'fs:allow-seek', 'fs:allow-ftruncate']) {
    assert.ok(identifiers.has(identifier), `main must grant handle operation ${identifier}`);
  }
});

test('reader capabilities retain random-access file reads', () => {
  for (const file of [
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const capability = readCapability(file);
    assert.ok(findPermission(capability, 'fs:read-files'));
  }
  assert.ok(
    readCapability('src-tauri/capabilities/ohos.json').permissions.includes('fs:allow-seek'),
  );
});

test('production capabilities contain no remote origin grants', () => {
  for (const file of PRODUCTION_CAPABILITY_FILES) {
    const capability = readCapability(file);
    assert.equal(capability.remote, undefined, `${file} must be local-only in release builds`);
  }
});

test('OHOS build grants remote origins only to explicit development profiles', () => {
  const buildConfig = readFileSync(join(repoRoot, 'src-tauri/build_config.rs'), 'utf8');
  const buildScript = readFileSync(join(repoRoot, 'src-tauri/build.rs'), 'utf8');

  assert.match(
    buildConfig,
    /OHOS_DEVELOPMENT_PROFILES: &\[&str\] = &\["debug", "dev"\]/,
  );
  assert.match(buildConfig, /_ => OHOS_PRODUCTION_CAPABILITY/);
  assert.match(
    buildScript,
    /ohos_capability_for_profile\(profile\.as_deref\(\)\)/,
  );
  for (const customProfile of ['release', 'staging', 'nightly']) {
    assert.ok(
      !buildConfig.match(/OHOS_DEVELOPMENT_PROFILES[^;]+;/s)?.[0].includes(`"${customProfile}"`),
      `${customProfile} must fail closed to the production capability`,
    );
  }
});

test('OHOS capabilities use the generated OpenHarmony schema', () => {
  for (const file of ['src-tauri/capabilities/ohos.json', DEV_OHOS_CAPABILITY]) {
    const capability = readCapability(file);
    assert.equal(capability.$schema, '../gen/schemas/open-harmony-schema.json');
    assert.doesNotThrow(() => JSON.parse(
      readFileSync(join(dirname(join(repoRoot, file)), capability.$schema), 'utf8'),
    ));
  }
});

test('OHOS dev capability differs only by its development server origins', () => {
  const production = readCapability('src-tauri/capabilities/ohos.json');
  const development = readCapability(DEV_OHOS_CAPABILITY);
  const { remote, ...developmentBase } = development;

  assert.deepEqual(developmentBase, production);
  assert.deepEqual(remote.urls, [
    'http://*:3000/**',
    'https://*:3000/**',
    'http://*:3001/**',
    'https://*:3001/**',
  ]);
});

test('HTTP access remains scheme-scoped for user-configured Talebook servers', () => {
  for (const file of [
    'src-tauri/capabilities/default.json',
    'src-tauri/capabilities/reader.json',
    'src-tauri/capabilities/reader-mobile.json',
  ]) {
    const permission = findPermission(readCapability(file), 'http:default');
    const urls = permission.allow.map((entry) => entry.url).sort();
    assert.deepEqual(urls, ['http://**', 'https://**']);
  }
});
