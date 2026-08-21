import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const expectedIosLocales = new Map([
  ['zh-Hans.lproj', '墨客'],
  ['zh-Hant.lproj', '墨客'],
]);

function findIosAppDirectory(appleRoot) {
  const appDirectory = readdirSync(appleRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('_iOS'))?.name;

  if (!appDirectory) {
    throw new Error(`Generated iOS app directory was not found under ${appleRoot}`);
  }
  return appDirectory;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertLocalizedValue(contents, key, value, file) {
  const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*=\\s*"${escapeRegExp(value)}"\\s*;`);
  if (!pattern.test(contents)) {
    throw new Error(`${file} does not set ${key} to ${value}`);
  }
}

export function prepareAndroidAppNames(root = projectRoot) {
  const sourceRoot = path.join(root, 'src-tauri', 'mobile', 'android');
  const generatedResources = path.join(
    root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res',
  );

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('values')) continue;
    const destinationDir = path.join(generatedResources, entry.name);
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(
      path.join(sourceRoot, entry.name, 'strings.xml'),
      path.join(destinationDir, 'strings.xml'),
    );
  }
}

export function verifyIosAppNames(root = projectRoot) {
  const appleRoot = path.join(root, 'src-tauri', 'gen', 'apple');
  const appDirectory = findIosAppDirectory(appleRoot);
  const generatedAppRoot = path.join(appleRoot, appDirectory);
  const infoPlistPath = path.join(generatedAppRoot, 'Info.plist');
  const infoPlist = readFileSync(infoPlistPath, 'utf8');

  for (const [locale, expectedName] of expectedIosLocales) {
    const stringsPath = path.join(appleRoot, 'Sources', locale, 'InfoPlist.strings');
    const contents = readFileSync(stringsPath, 'utf8');
    assertLocalizedValue(contents, 'CFBundleDisplayName', expectedName, stringsPath);
    assertLocalizedValue(contents, 'CFBundleName', expectedName, stringsPath);
  }

  const xcodeProject = readdirSync(appleRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))?.name;
  if (!xcodeProject) {
    throw new Error(`Generated Xcode project was not found under ${appleRoot}`);
  }

  const pbxprojPath = path.join(appleRoot, xcodeProject, 'project.pbxproj');
  const pbxproj = readFileSync(pbxprojPath, 'utf8');
  const hasDirectDefault = /<key>CFBundleDisplayName<\/key>\s*<string>Moke<\/string>/.test(infoPlist);
  const hasProductNameDefault = /<key>CFBundleName<\/key>\s*<string>\$\(PRODUCT_NAME\)<\/string>/.test(infoPlist)
    && /PRODUCT_NAME = "?Moke"?;/.test(pbxproj);
  if (!hasDirectDefault && !hasProductNameDefault) {
    throw new Error(`${infoPlistPath} does not resolve the default app name to Moke`);
  }

  if (!/InfoPlist\.strings in Resources/.test(pbxproj)) {
    throw new Error(`${pbxprojPath} does not add InfoPlist.strings to a Resources build phase`);
  }
  if (!/isa = PBXVariantGroup;[\s\S]*?\/\* InfoPlist\.strings \*\//.test(pbxproj)
      && !/\/\* InfoPlist\.strings \*\/[\s\S]*?isa = PBXVariantGroup;/.test(pbxproj)) {
    throw new Error(`${pbxprojPath} does not define InfoPlist.strings as a localized variant group`);
  }

  for (const locale of expectedIosLocales.keys()) {
    const localizedPath = `${locale}/InfoPlist.strings`;
    if (!pbxproj.includes(localizedPath)) {
      throw new Error(`${pbxprojPath} does not reference ${localizedPath}`);
    }
  }
}

export function prepareIosAppNames(root = projectRoot, run = spawnSync) {
  const appleRoot = path.join(root, 'src-tauri', 'gen', 'apple');
  findIosAppDirectory(appleRoot);
  const sourceRoot = path.join(root, 'src-tauri', 'mobile', 'ios');

  // `project.yml` already adds Sources to the iOS target. Keeping localized
  // strings under that source tree makes XcodeGen add them to Resources as a
  // PBXVariantGroup; the adjacent <app>_iOS directory only contains Info.plist
  // and is not a project source.
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
    const destinationDir = path.join(appleRoot, 'Sources', entry.name);
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(
      path.join(sourceRoot, entry.name, 'InfoPlist.strings'),
      path.join(destinationDir, 'InfoPlist.strings'),
    );
  }

  // The generated Xcode project only knows about files that existed when
  // `tauri ios init` ran. Regenerate it with the pinned XcodeGen installed by CI.
  const result = run(
    'xcodegen',
    ['generate', '--no-env', '--spec', path.join(appleRoot, 'project.yml')],
    { cwd: appleRoot, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) {
    throw new Error(
      'XcodeGen is required to add localized iOS app names; install the version declared in build-release.yml',
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(`xcodegen exited with status ${result.status}`);
  }

  verifyIosAppNames(root);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const platform = process.argv[2];
  if (platform === 'android') {
    prepareAndroidAppNames();
    console.log('[app-names] Added Android default and Chinese app names');
  } else if (platform === 'ios') {
    prepareIosAppNames();
    console.log('[app-names] Added and verified iOS Chinese app names');
  } else {
    console.error('Usage: node scripts/prepare-mobile-app-names.mjs <android|ios>');
    process.exitCode = 1;
  }
}
