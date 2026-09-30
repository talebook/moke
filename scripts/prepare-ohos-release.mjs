import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OHOS_RELEASE_BUNDLE = 'org.houheya.moke_openharmony';

// The Huawei distribution profile fixes the native package identity. Keep the
// Tauri Preview identifier and feature checks unchanged for the licensing flow.
export function prepareOhosRelease(file = 'src-tauri/gen/ohos/AppScope/app.json5') {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (![OHOS_RELEASE_BUNDLE, 'org.houheya.moke.preview'].includes(manifest.app?.bundleName)) {
    throw new Error('Unexpected OHOS package identity; refusing to replace it');
  }
  manifest.app.bundleName = OHOS_RELEASE_BUNDLE;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareOhosRelease();
}
