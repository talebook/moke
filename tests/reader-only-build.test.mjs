import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gitmodules = readFileSync(new URL('../.gitmodules', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const contractUrl = new URL('../readest/contract/moke-reader.v1.json', import.meta.url);
assert.ok(
  existsSync(contractUrl),
  'Reader submodule is missing; run `git submodule sync --recursive && git submodule update --init --recursive`.',
);
const contract = JSON.parse(readFileSync(contractUrl, 'utf8'));
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
const readerNativeHost = readFileSync(
  new URL('../readest/apps/readest-app/src-tauri/src/lib.rs', import.meta.url),
  'utf8',
);
const readerDirScanner = readFileSync(
  new URL('../readest/apps/readest-app/src-tauri/src/dir_scanner.rs', import.meta.url),
  'utf8',
);
const readerCapability = JSON.parse(
  readFileSync(new URL('../src-tauri/capabilities/reader.json', import.meta.url), 'utf8'),
);

function appAclCommands(source) {
  const block = source.match(/const APP_ACL_COMMANDS:.*?= &\[([\s\S]*?)\n\];/)?.[1];
  assert.ok(block, 'APP_ACL_COMMANDS must remain a literal list for contract validation');
  return [...block.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function bracketedMacroBody(source, functionName, macroName) {
  const functionStart = source.indexOf(functionName);
  assert.notEqual(functionStart, -1, `${functionName} is missing from the Reader native contract`);
  const macroStart = source.indexOf(macroName, functionStart);
  assert.notEqual(macroStart, -1, `${functionName} must expose commands through ${macroName}`);
  const openingBracket = source.indexOf('[', macroStart + macroName.length);
  assert.notEqual(openingBracket, -1, `${macroName} must use an array-style command body`);

  let depth = 0;
  for (let index = openingBracket; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    if (source[index] !== ']') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBracket + 1, index);
  }
  assert.fail(`${macroName} has an unbalanced command body`);
}

function readerHandlerCommands(source) {
  const block = bracketedMacroBody(source, 'pub fn reader_invoke_handler', 'tauri::generate_handler!');
  return [...block.matchAll(/^\s*([a-z_][a-z0-9_:]*)\s*,\s*$/gim)]
    .map((match) => match[1].split('::').pop());
}

test('Moke 构建只暴露独立 Readest Reader 页面', () => {
  assert.match(gitmodules, /https:\/\/github\.com\/hehetoshang\/readest-reader\.git/);
  assert.equal(contract.id, 'moke.readest.embed.v1');
  assert.equal(contract.readerRoute, '/readest/reader');
  assert.equal(contract.progressApi.credentials, 'include');
  assert.equal(contract.onlineSource.rangeRequired, true);
  assert.equal(contract.onlineSource.redirects, 0);
  assert.deepEqual(contract.onlineSource.formats, ['epub']);
  assert.ok(contract.readerEvents.includes('reader:error'));
  assert.match(rootPackage.scripts['build:reader'], /build:moke-reader/);
  assert.equal(rootPackage.scripts['dev:reader'], 'cd readest && pnpm dev');
  assert.match(readerPackage.scripts['build:moke-reader'], /build:reader/);
  assert.match(readerPackage.scripts['build:reader'], /\.env\.moke-reader/);
  assert.match(nextConfig, /pageExtensions: \['moke\.tsx'\]/);
  assert.match(readerEntry, /<Reader \/>/);
  assert.doesNotMatch(readerEntry, /Library/);
  assert.match(tauriBuild, /AppManifest::new\(\)\.commands\(APP_ACL_COMMANDS\)/);
  assert.ok(readerCapability.permissions.includes('allow-get-executable-dir'));
  assert.ok(readerCapability.permissions.includes('allow-ext-reader-event'));
  assert.match(readme, /git submodule sync --recursive/);
  assert.match(tauriManifest, /reader-e2e = \["tauri-plugin-webdriver"\]/);
  assert.match(tauriManifest, /tauri-plugin-webdriver = \{ version = "=0\.2\.1", optional = true \}/);
  assert.match(
    tauriHost,
    /cfg\(all\(feature = "reader-e2e", not\(debug_assertions\)\)\)[\s\S]*compile_error!\("reader-e2e must not be enabled in release builds"\)/,
  );
  assert.match(tauriHost, /reader-e2e is supported only by desktop development builds/);
  assert.match(tauriHost, /target_env = "ohos"/);
  assert.match(tauriHost, /cfg\(all\(feature = "reader-e2e", debug_assertions\)\)/);
  assert.match(tauriHost, /tauri_plugin_webdriver::init\(\)/);
  assert.match(tauriHost, /http:\/\/localhost:3001\/readest\/\*\*/);
  assert.match(
    tauriHost,
    /cfg!\(feature = "reader-e2e"\)[\s\S]*http:\/\/localhost:3001\/\*\*/,
  );
});

test('Moke ACL command manifest stays aligned with Reader plus the explicit host surface', () => {
  const mokeHostCommands = [
    'moke_runtime_platform',
    'moke_navigate',
    'moke_record_downloaded_book',
    'moke_delete_downloaded_book_file',
    'moke_open_downloaded_book',
    'moke_reveal_downloaded_book',
    'moke_remove_downloaded_book',
    'moke_select_download_directory',
    'moke_reset_download_directory',
    'moke_get_download_directory',
    'moke_download_storage_stats',
    'moke_list_downloaded_books',
  ];
  const expected = [
    ...new Set([...readerHandlerCommands(readerNativeHost), ...mokeHostCommands, 'ext_reader_event']),
  ].sort();
  assert.deepEqual([...new Set(appAclCommands(tauriBuild))].sort(), expected);
});

test('embedded Reader preserves the untrusted-publication filesystem boundary', () => {
  assert.match(readerNativeHost, /if !fs_scope\.is_allowed\(&path\)[\s\S]*?continue;/);
  assert.match(readerDirScanner, /if !scope\.is_allowed\(&path_buf\)/);
  assert.match(readerCapability.description, /sandbox/i);
});
