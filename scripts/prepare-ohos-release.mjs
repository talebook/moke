import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OHOS_RELEASE_BUNDLE = 'org.houheya.moke_openharmony';

const PROFILE_ARGS = 'const rustProfileArgs = properties.buildMode === "release" ? ["--release"] : [];';
const TARGET_ARGS = '"--target", target.toString()';

// The pinned Tauri Hvigor hook calls dev-eco-studio-script, whose default is
// Debug even when `tauri ohos build` has already built a Release library. That
// second build copies its library into the HAP. Forward Hvigor's buildMode so
// release HAPs actually contain optimized Rust code, and debug builds stay debug.
export function patchHvigorRustProfile(source) {
  const hasDeclaration = source.includes(PROFILE_ARGS);
  const hasArguments = source.includes(`${TARGET_ARGS}, ...rustProfileArgs`);
  if (hasDeclaration && hasArguments) return source;
  if (hasDeclaration || hasArguments) {
    throw new Error('Partially patched OHOS Rust profile; regenerate the Hvigor file');
  }
  const target = 'const target = properties.target || "aarch64";';
  const args = `${TARGET_ARGS}]`;
  if (
    !source.includes('hvigor.getParameter().getProperties()')
    || source.split(target).length !== 2
    || source.split(args).length !== 2
  ) {
    throw new Error('Unsupported OHOS Hvigor Rust hook; review build profile forwarding');
  }
  return source
    .replace(target, `${target}\n        ${PROFILE_ARGS}`)
    .replace(args, `${TARGET_ARGS}, ...rustProfileArgs]`);
}

export function prepareOhosRustProfile(file = 'src-tauri/gen/ohos/entry/hvigorfile.ts') {
  const original = readFileSync(file, 'utf8');
  const patched = patchHvigorRustProfile(original);
  if (patched !== original) writeFileSync(file, patched, 'utf8');
}

// Tauri init, Tauri build and the Huawei Profile must share one identity.
// Changing only AppScope makes Tauri reject the generated project as outdated.
export function prepareOhosRelease(file = 'src-tauri/gen/ohos/AppScope/app.json5') {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.app?.bundleName !== OHOS_RELEASE_BUNDLE) {
    throw new Error('Unexpected OHOS package identity; initialize with the release bundle identifier');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareOhosRelease();
  prepareOhosRustProfile();
}
