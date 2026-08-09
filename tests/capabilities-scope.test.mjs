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

// HOU-15 H1 / HOU-30 regression guard: the fs/opener capability allow lists
// were narrowed away from unrestricted `**` path grants. Fail if any fs:* or
// opener:* permission ever re-introduces a `"path": "**"` allow entry.
for (const file of CAPABILITY_FILES) {
  test(`${file} has no fs/opener allow entry with path "**"`, () => {
    const capability = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    const offenders = [];
    for (const permission of capability.permissions) {
      if (typeof permission === 'string') continue;
      const identifier = permission.identifier ?? '';
      if (!identifier.startsWith('fs:') && !identifier.startsWith('opener:')) continue;
      for (const entry of permission.allow ?? []) {
        if (entry && typeof entry === 'object' && entry.path === '**') {
          offenders.push(identifier);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
}
