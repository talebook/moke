import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OHOS_RELEASE_BUNDLE = 'org.houheya.moke_openharmony';

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
}
