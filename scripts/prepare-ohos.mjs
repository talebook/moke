import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// `ohpm install` may resolve @ohos-rs/ability into gen/ohos/oh_modules
// (project root) or gen/ohos/entry/oh_modules (module-scoped); search both.
const packageRoots = [
  join(ohosRoot, 'oh_modules'),
  join(ohosRoot, 'entry', 'oh_modules'),
];

function findFileIn(dir, name) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const found = findFileIn(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

function findFileAcross(roots, name) {
  for (const root of roots) {
    const found = findFileIn(root, name);
    if (found) return found;
  }
  return null;
}

// npm/ohpm scoped packages land on disk as nested dirs (@ohos-rs/ability →
// @ohos-rs/ability), so walk the path segments instead of matching one entry.
function findPackageDir(roots, name) {
  const parts = name.split('/');
  for (const root of roots) {
    let current = root;
    let ok = true;
    for (const part of parts) {
      current = join(current, part);
      if (!existsSync(current) || !statSync(current).isDirectory()) {
        ok = false;
        break;
      }
    }
    if (ok) return current;
  }
  return null;
}

// ArkWeb 的 Web 组件 `domStorageAccess` 默认是 false（见 SDK 类型定义），
// 导致 window.localStorage 为 null，zustand persist 完全无法持久化。
// @ohos-rs/ability 的 DefaultWebview.ets 没有开启它，这里在构建时打补丁：
// 给 Web 组件链式调用加上 .domStorageAccess(true)。
// 注意：back-key 补丁文件 webview/DefaultWebview.ets 自身已带 domStorageAccess，
// 下方的追加逻辑只作为兜底（例如包布局变化导致补丁未拷贝时）。
function ensureDomStorage() {
  const webviewPath = findFileAcross(packageRoots, 'DefaultWebview.ets');
  if (!webviewPath) {
    console.warn('[prepare-ohos] DefaultWebview.ets not found; DOM Storage patch skipped.');
    return;
  }
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
}

// OHOS back-key 补丁：把 ohos-ability-patch/ 下的文件覆盖到 ohpm 安装的
// @ohos-rs/ability 包内（src/main/ets 布局与包源码一致）。原先由
// scripts/patch-ohos-ability.ps1 负责，但没有任何 CI 步骤调用它（且 CI 跑在
// Linux 上无法执行 PowerShell），补丁从未生效。这里统一由本脚本维护。
const patchDir = fileURLToPath(new URL('./ohos-ability-patch', import.meta.url));
const patchFiles = [
  'webview/Utils.ets',
  'webview/DefaultWebview.ets',
  'components/DefaultXComponent.ets',
  'components/MainPage.ets',
];

const abilityDir = findPackageDir(packageRoots, '@ohos-rs/ability');
if (abilityDir) {
  const etsDir = join(abilityDir, 'src', 'main', 'ets');
  let applied = 0;
  for (const rel of patchFiles) {
    const src = join(patchDir, rel);
    const dst = join(etsDir, rel);
    if (!existsSync(src)) {
      console.warn(`[prepare-ohos] Patch file missing: ${src}`);
      continue;
    }
    if (!existsSync(dst)) {
      console.warn(`[prepare-ohos] Patch target missing (package layout changed?): ${dst}`);
      continue;
    }
    copyFileSync(src, dst);
    applied += 1;
  }
  console.log(
    `[prepare-ohos] Applied ${applied}/${patchFiles.length} @ohos-rs/ability back-key patches to ${etsDir}`,
  );
} else {
  console.warn('[prepare-ohos] @ohos-rs/ability package not found; back-key patches skipped.');
}

ensureDomStorage();
