import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gitmodules = readFileSync(new URL('../.gitmodules', import.meta.url), 'utf8');
const contract = JSON.parse(
  readFileSync(new URL('../readest/contract/moke-reader.v1.json', import.meta.url), 'utf8'),
);
const readerPackage = JSON.parse(
  readFileSync(new URL('../readest/apps/readest-app/package.json', import.meta.url), 'utf8'),
);
const nextConfig = readFileSync(
  new URL('../readest/apps/readest-app/next.config.mjs', import.meta.url),
  'utf8',
);
const readerEntry = readFileSync(
  new URL('../readest/apps/readest-app/src/pages/reader.moke.tsx', import.meta.url),
  'utf8',
);
const tauriManifest = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const tauriBuild = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const tauriHost = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const readerCapability = JSON.parse(
  readFileSync(new URL('../src-tauri/capabilities/reader.json', import.meta.url), 'utf8'),
);

test('Moke 构建只暴露独立 Readest Reader 页面', () => {
  assert.match(gitmodules, /https:\/\/github\.com\/hehetoshang\/readest-reader\.git/);
  assert.equal(contract.id, 'moke.readest.embed.v1');
  assert.equal(contract.readerRoute, '/readest/reader');
  assert.equal(contract.progressApi.credentials, 'include');
  assert.ok(contract.readerEvents.includes('reader:error'));
  assert.match(rootPackage.scripts['build:reader'], /build:moke-reader/);
  assert.match(readerPackage.scripts['build:moke-reader'], /build:reader/);
  assert.match(readerPackage.scripts['build:reader'], /\.env\.moke-reader/);
  assert.match(nextConfig, /pageExtensions: \['moke\.tsx'\]/);
  assert.match(readerEntry, /<Reader \/>/);
  assert.doesNotMatch(readerEntry, /Library/);
  assert.match(tauriBuild, /AppManifest::new\(\)\.commands\(READER_COMMANDS\)/);
  assert.ok(readerCapability.permissions.includes('allow-get-executable-dir'));
  assert.ok(readerCapability.permissions.includes('allow-ext-reader-event'));
  assert.match(tauriManifest, /reader-e2e = \["tauri-plugin-webdriver"\]/);
  assert.match(tauriManifest, /tauri-plugin-webdriver = \{ version = "0\.2", optional = true \}/);
  assert.match(tauriHost, /cfg\(feature = "reader-e2e"\)/);
  assert.match(tauriHost, /tauri_plugin_webdriver::init\(\)/);
});
