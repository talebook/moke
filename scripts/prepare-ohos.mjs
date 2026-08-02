import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL(
  '../src-tauri/gen/ohos/entry/src/main/module.json5',
  import.meta.url,
);
const manifestPath = fileURLToPath(manifestUrl);

if (!existsSync(manifestPath)) {
  console.warn(`[prepare-ohos] Skipping missing generated manifest: ${manifestPath}`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const permissions = (manifest.module.requestPermissions ??= []);
const requiredPermissions = [
  'ohos.permission.INTERNET',
  // ArkWeb needs this to resolve the default network and expose a correct
  // online state to third-party JavaScript challenges such as GeeTest.
  'ohos.permission.GET_NETWORK_INFO',
];

let changed = false;
for (const name of requiredPermissions) {
  if (!permissions.some((permission) => permission?.name === name)) {
    permissions.push({ name });
    changed = true;
  }
}

if (changed) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('[prepare-ohos] Added required ArkWeb network permissions.');
} else {
  console.log('[prepare-ohos] ArkWeb network permissions are already configured.');
}
