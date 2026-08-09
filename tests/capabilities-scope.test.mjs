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
const ALLOWED_FS_OPEN_PREFIXES = [
  '$APPDATA',
  '$APPCONFIG',
  '$APPCACHE',
  '$APPLOG',
  '$TEMP',
  '$RESOURCE',
];

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

function isRestrictedToPrivateDirs(path) {
  return ALLOWED_FS_OPEN_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\\\`)
  );
}

for (const file of CAPABILITY_FILES) {
  test(`${file} fs/opener allow entries are restricted to app-private/temp dirs`, () => {
    const capability = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    const offenders = collectFsOpenerAllowEntries(capability)
      .filter(({ path }) => !isRestrictedToPrivateDirs(path))
      .map(({ identifier, path }) => `${identifier}: ${path}`);
    assert.deepEqual(offenders, []);
  });
}

test('default.json and ohos.json fs:scope allow lists are identical', () => {
  const readScope = (file) => {
    const capability = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    const scope = capability.permissions.find(
      (p) => typeof p === 'object' && p.identifier === 'fs:scope'
    );
    assert.ok(scope, `${file} must declare fs:scope`);
    return JSON.stringify(scope.allow ?? []);
  };
  const [defaultFile, ohosFile] = CAPABILITY_FILES;
  assert.equal(readScope(defaultFile), readScope(ohosFile));
});
