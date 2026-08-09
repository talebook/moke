import {
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// The @ohos-rs/ability files overlaid onto the ohpm-installed package. Kept in
// sync with the actual layout under scripts/ohos-ability-patch/.
export const DEFAULT_PATCH_FILES = [
  'webview/Utils.ets',
  'webview/DefaultWebview.ets',
  'components/DefaultXComponent.ets',
  'components/MainPage.ets',
];

// `ohpm install` may resolve @ohos-rs/ability into gen/ohos/entry/oh_modules
// (module-scoped, what the entry module actually compiles against) or
// gen/ohos/oh_modules (project root). entry/oh_modules wins on priority and
// MUST stay in sync with the CI assertion in
// .github/workflows/build-release.yml.
export function packageRootsFor(ohosRoot) {
  return [join(ohosRoot, 'entry', 'oh_modules'), join(ohosRoot, 'oh_modules')];
}

// npm/ohpm scoped packages land on disk as nested dirs (@ohos-rs/ability →
// @ohos-rs/ability), so walk the path segments instead of matching one entry.
export function findPackageDir(root, name) {
  const parts = name.split('/');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current) || !statSync(current).isDirectory()) {
      return null;
    }
  }
  return current;
}

export function applyPatchesToPackage(abilityDir, patchDir, patchFiles) {
  const etsDir = join(abilityDir, 'src', 'main', 'ets');
  const applied = [];
  const failed = [];
  for (const rel of patchFiles) {
    const src = join(patchDir, rel);
    const dst = join(etsDir, rel);
    if (!existsSync(src)) {
      failed.push(`${rel} (patch source missing: ${src})`);
      continue;
    }
    if (!existsSync(dst)) {
      failed.push(`${rel} (package target missing: ${dst})`);
      continue;
    }
    copyFileSync(src, dst);
    applied.push(rel);
  }
  return { etsDir, applied, failed };
}

// ArkWeb's Web component `domStorageAccess` defaults to false, which makes
// window.localStorage null and breaks zustand persist. The patch copy of
// DefaultWebview.ets already carries domStorageAccess(true); this is only a
// fallback for a package whose DefaultWebview.ets differs from the patch.
// Never writes unless the replace actually changed the content.
export function ensureDomStorage(abilityDir) {
  const webviewPath = join(
    abilityDir,
    'src',
    'main',
    'ets',
    'webview',
    'DefaultWebview.ets',
  );
  if (!existsSync(webviewPath)) {
    return { status: 'missing', webviewPath };
  }
  const original = readFileSync(webviewPath, 'utf8');
  if (original.includes('domStorageAccess')) {
    return { status: 'already-present', webviewPath };
  }
  const next = original.replace(
    '.javaScriptAccess(data?.javascriptEnable)',
    '.javaScriptAccess(data?.javascriptEnable)\n    .domStorageAccess(true)',
  );
  if (next === original) {
    return { status: 'no-anchor', webviewPath };
  }
  writeFileSync(webviewPath, next, 'utf8');
  return { status: 'patched', webviewPath };
}

export function prepareOhos({ ohosRoot, patchDir, patchFiles = DEFAULT_PATCH_FILES }) {
  const packageRoots = packageRootsFor(ohosRoot);
  const results = [];
  for (const root of packageRoots) {
    const abilityDir = findPackageDir(root, '@ohos-rs/ability');
    if (!abilityDir) continue;
    results.push({
      abilityDir,
      patches: applyPatchesToPackage(abilityDir, patchDir, patchFiles),
      domStorage: ensureDomStorage(abilityDir),
    });
  }
  return { packageRoots, results };
}


