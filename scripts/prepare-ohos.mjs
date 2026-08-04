import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// ArkWeb 的 Web 组件 `domStorageAccess` 默认是 false（见 SDK 类型定义），
// 导致 window.localStorage 为 null，zustand persist 完全无法持久化。
// @ohos-rs/ability 的 DefaultWebview.ets 没有开启它，这里在构建时打补丁：
// 给 Web 组件链式调用加上 .domStorageAccess(true)。
function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

const webviewPath = findFile(
  fileURLToPath(new URL('../src-tauri/gen/ohos/oh_modules', import.meta.url)),
  'DefaultWebview.ets',
);
if (webviewPath) {
  let content = readFileSync(webviewPath, 'utf8');
  if (!content.includes('domStorageAccess')) {
    content = content.replace(
      '.javaScriptAccess(data?.javascriptEnable)',
      '.javaScriptAccess(data?.javascriptEnable)\n    .domStorageAccess(true)',
    );
    writeFileSync(webviewPath, content, 'utf8');
    console.log(`[prepare-ohos] Enabled DOM Storage in ArkWeb Web component (${webviewPath}).`);
  } else {
    console.log('[prepare-ohos] DOM Storage already enabled in ArkWeb Web component.');
  }
} else {
  console.warn('[prepare-ohos] DefaultWebview.ets not found; DOM Storage patch skipped.');
}
