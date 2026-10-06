import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPORT = "import { OhosOpener } from './Opener';";
const FIELD = '  private mokeOpener: OhosOpener = new OhosOpener();';
const INSTALL = '    this.mokeOpener.install(this.context, this.moduleName);';
const DISPOSE = `  onDestroy(): void | Promise<void> {
    this.mokeOpener.dispose();
    return super.onDestroy();
  }
`;

// Modify only the app's generated EntryAbility, never the official ability
// package, Tauri template, icons or resources. Fail closed if upstream changes
// the expected lifecycle shape; do not silently ship an unregistered adapter.
export function integrateOpener(source) {
  const markers = [IMPORT, FIELD, INSTALL, DISPOSE];
  if (markers.every((marker) => source.includes(marker))) return source;
  if (markers.some((marker) => source.includes(marker))) {
    throw new Error('Partially installed OHOS opener; regenerate EntryAbility before preparing');
  }
  const declaration = 'export default class EntryAbility extends RustAbility {';
  const create = '    super.onCreate(want, launchParam);';
  if (!source.includes(declaration) || !source.includes(create) || /\bonDestroy\s*\(/.test(source)) {
    throw new Error('Unsupported EntryAbility lifecycle; review OHOS opener integration');
  }
  return `${IMPORT}\n${source}`
    .replace(declaration, `${declaration}\n${FIELD}\n\n${DISPOSE}`)
    // Install before RustAbility starts the Rust runtime. Await base creation,
    // so lifecycle initialization errors do not become unhandled rejections.
    .replace(create, `${INSTALL}\n    await super.onCreate(want, launchParam);`);
}

export function prepareOpener(ohosRoot, adapterPath) {
  const directory = join(ohosRoot, 'entry/src/main/ets/entryability');
  const entry = join(directory, 'EntryAbility.ets');
  const original = readFileSync(entry, 'utf8');
  const integrated = integrateOpener(original);
  copyFileSync(adapterPath, join(directory, 'Opener.ets'));
  if (integrated !== original) writeFileSync(entry, integrated, 'utf8');
}
