import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PATCH_FILES, prepareOhos } from './ohos-prepare-core.mjs';

const ohosRoot = fileURLToPath(new URL('../src-tauri/gen/ohos', import.meta.url));

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

// OHOS back-key 补丁：把 ohos-ability-patch/ 下的文件覆盖到 ohpm 安装的
// @ohos-rs/ability 包内（src/main/ets 布局与包源码一致）。原先由
// scripts/patch-ohos-ability.ps1 负责，但没有任何 CI 步骤调用它（且 CI 跑在
// Linux 上无法执行 PowerShell），补丁从未生效。这里统一由本脚本维护。
// entry/oh_modules 与根 oh_modules 都可能存在，逐个全部打补丁。
const patchDir = fileURLToPath(new URL('./ohos-ability-patch', import.meta.url));
const { results } = prepareOhos({ ohosRoot, patchDir });

if (results.length === 0) {
  console.warn('[prepare-ohos] @ohos-rs/ability package not found; patches skipped (run `ohpm install` in src-tauri/gen/ohos first).');
} else {
  let hardFailed = false;
  for (const result of results) {
    const { applied, failed, etsDir } = result.patches;
    console.log(
      `[prepare-ohos] Applied ${applied.length}/${DEFAULT_PATCH_FILES.length} @ohos-rs/ability back-key patches to ${etsDir}`,
    );
    for (const message of failed) {
      hardFailed = true;
      console.error(`[prepare-ohos] FAILED to apply back-key patch: ${message}`);
    }
    const storage = result.domStorage;
    if (storage.status === 'patched') {
      console.log(`[prepare-ohos] Enabled DOM Storage in ArkWeb Web component (${storage.webviewPath}).`);
    } else if (storage.status === 'already-present') {
      console.log('[prepare-ohos] DOM Storage already enabled in ArkWeb Web component.');
    } else if (storage.status === 'no-anchor') {
      console.warn(
        `[prepare-ohos] WARNING: could not find .javaScriptAccess(data?.javascriptEnable) anchor in ${storage.webviewPath}; DOM Storage not patched.`,
      );
    } else {
      console.warn(`[prepare-ohos] WARNING: ${storage.webviewPath} not found; DOM Storage check skipped.`);
    }
  }
  if (hardFailed) {
    console.error('[prepare-ohos] Back-key patches partially failed; aborting build.');
    process.exit(1);
  }
}
