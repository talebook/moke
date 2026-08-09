import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const CAPABILITY_FILES = [
  'src-tauri/capabilities/default.json',
  'src-tauri/capabilities/ohos.json',
];

// HOU-15 H1 / HOU-30 regression guard. The fs/opener capability allow lists
// were narrowed away from unrestricted path grants. A `**` catch-all must not
// come back, whether written exactly, as `**/*`, under a home/root prefix
// (`$HOME/**`, `C:\**`), or any other equivalent full-disk pattern. Only
// application-private / temp base dirs are allowed in fs/opener allow entries.
//
// `$RESOURCE` (the install dir) is deliberately NOT whitelisted: none of the
// capability files grants it, and writing to it would overwrite the app
// binary/resources. Static packaged assets are served via the asset protocol
// (see tauri.conf.json assetProtocol scope), not the fs plugin.
const ALLOWED_FS_OPEN_PREFIXES = [
  '$APPDATA',
  '$APPCONFIG',
  '$APPCACHE',
  '$APPLOG',
  '$TEMP',
];

function readCapability(file) {
  return JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
}

function collectFsOpenerAllowEntries(capability) {
  const entries = [];
  for (const permission of capability.permissions) {
    if (typeof permission === 'string') continue;
    const identifier = permission.identifier ?? '';
    if (!identifier.startsWith('fs:') && !identifier.startsWith('opener:')) continue;
    for (const entry of permission.allow ?? []) {
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        entries.push({ identifier, path: entry.path });
      }
    }
  }
  return entries;
}

function hasParentDirTraversal(path) {
  return path.split(/[\\/]/).includes('..');
}

// A path is restricted only when it points strictly *inside* an allowed base
// dir — `$APPDATA/**`, `$APPDATA/settings.json`, `$APPDATA\books\x` — and not
// at the bare root itself. A bare `$APPDATA` entry would put the whole
// app-data root into scope, allowing `remove(appDataDir(), {recursive:true})`
// etc. (the exact regression this PR removed), so bare roots are rejected.
// Matching must use a single backslash (`\`), the form JSON.parse produces.
function isRestrictedToPrivateDirs(path) {
  if (hasParentDirTraversal(path)) return false;
  return ALLOWED_FS_OPEN_PREFIXES.some(
    (prefix) => path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`)
  );
}

for (const file of CAPABILITY_FILES) {
  test(`${file} fs/opener allow entries are restricted to app-private/temp dirs`, () => {
    const capability = readCapability(file);
    const offenders = collectFsOpenerAllowEntries(capability)
      .filter(({ path }) => !isRestrictedToPrivateDirs(path))
      .map(({ identifier, path }) => `${identifier}: ${path}`);
    assert.deepEqual(offenders, []);
  });
}

const FS_LIST_PERMISSIONS = [
  'fs:allow-read',
  'fs:allow-write',
  'fs:allow-write-text-file',
  'fs:allow-write-file',
  'fs:allow-mkdir',
  'fs:scope',
];

// The Tauri v2 fs plugin merges every fs allow list into one global scope, so
// default.json and ohos.json must agree on all of them — not just fs:scope.
// Compare the parsed arrays directly (deepEqual) to avoid order-sensitivity.
for (const identifier of FS_LIST_PERMISSIONS) {
  test(`default.json and ohos.json ${identifier} allow lists are identical`, () => {
    const getList = (file) => {
      const capability = readCapability(file);
      const permission = capability.permissions.find(
        (p) => typeof p === 'object' && p.identifier === identifier
      );
      assert.ok(permission, `${file} must declare ${identifier}`);
      return permission.allow ?? [];
    };
    const [defaultFile, ohosFile] = CAPABILITY_FILES;
    assert.deepEqual(getList(defaultFile), getList(ohosFile));
  });
}
