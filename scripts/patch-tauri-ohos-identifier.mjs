import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../vendor/tauri/crates/tauri-cli/src/build.rs', import.meta.url));
const original = `  if config
    .identifier
    .chars()
    .any(|ch| !(ch.is_alphanumeric() || ch == '-' || ch == '.'))
  {`;
const replacement = `  // Huawei OpenHarmony debug profiles may use this app-specific underscore.
  if config.identifier != "org.houheya.moke_openharmony"
    && config
      .identifier
      .chars()
      .any(|ch| !(ch.is_alphanumeric() || ch == '-' || ch == '.'))
  {`;

export function patchTauriOhosIdentifier(source) {
  if (source.includes(replacement)) return source;
  if (!source.includes(original)) {
    throw new Error('Tauri CLI bundle identifier validator changed; update the OHOS patch');
  }
  return source.replace(original, replacement);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(sourcePath, 'utf8');
  const patched = patchTauriOhosIdentifier(source);
  if (patched !== source) writeFileSync(sourcePath, patched);
  console.log('[ohos] Tauri CLI accepts the Huawei profile bundle identifier');
}
