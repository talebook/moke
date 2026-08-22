import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const pbxObjectIdPattern = '[A-F0-9]{24}';
const expectedIosLocales = new Map([
  // XcodeGen uses the development language (`en` by default) as the anchor
  // when it creates a PBXVariantGroup. Keep this default localization even
  // though Info.plist already falls back to the same product name.
  ['en.lproj', 'Moke'],
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

function readPlistString(contents, key) {
  const match = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`,
  ).exec(contents);
  return match?.[1].trim();
}

function assertDefaultIosAppName(infoPlist, pbxproj, expectedName, infoPlistPath) {
  const displayName = readPlistString(infoPlist, 'CFBundleDisplayName');
  const key = displayName === undefined ? 'CFBundleName' : 'CFBundleDisplayName';
  const configuredName = displayName === undefined
    ? readPlistString(infoPlist, 'CFBundleName')
    : displayName;
  const productNamePattern = new RegExp(
    `\\bPRODUCT_NAME\\s*=\\s*(?:"${escapeRegExp(expectedName)}"|${escapeRegExp(expectedName)})\\s*;`,
  );
  const resolvesToExpectedName = configuredName === expectedName
    || (configuredName === '$(PRODUCT_NAME)' && productNamePattern.test(pbxproj));

  if (!resolvesToExpectedName) {
    throw new Error(`${infoPlistPath} does not resolve ${key} to ${expectedName}`);
  }
}

function findInfoPlistVariantGroup(pbxproj, pbxprojPath) {
  const variantGroup = new RegExp(
    `^[\\t ]*(${pbxObjectIdPattern}) /\\* InfoPlist\\.strings \\*/ = \\{\\r?\\n([\\s\\S]*?)^[\\t ]*\\};[\\t ]*$`,
    'm',
  ).exec(pbxproj);

  if (!variantGroup
      || !/^[\t ]*isa = PBXVariantGroup;[\t ]*$/m.test(variantGroup[2])
      || !/^[\t ]*name = "?InfoPlist\.strings"?;[\t ]*$/m.test(variantGroup[2])) {
    throw new Error(`${pbxprojPath} does not define InfoPlist.strings as a localized variant group`);
  }

  return { id: variantGroup[1], body: variantGroup[2] };
}

function assertVariantGroupIsResource(pbxproj, variantGroupId, pbxprojPath) {
  const buildFile = new RegExp(
    `^[\\t ]*(${pbxObjectIdPattern}) /\\* InfoPlist\\.strings in Resources \\*/ = \\{isa = PBXBuildFile;[^\\r\\n]*fileRef = ${variantGroupId} /\\* InfoPlist\\.strings \\*/;[^\\r\\n]*\\};[\\t ]*$`,
    'm',
  ).exec(pbxproj);
  const resourcesSection = /\/\* Begin PBXResourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXResourcesBuildPhase section \*\//
    .exec(pbxproj)?.[1];

  if (!buildFile || !resourcesSection?.includes(buildFile[1])) {
    throw new Error(`${pbxprojPath} does not add InfoPlist.strings to a Resources build phase`);
  }
}

function assertLocaleInVariantGroup(pbxproj, variantGroup, locale, pbxprojPath) {
  const localizedPath = `${locale}/InfoPlist.strings`;
  const pathPattern = new RegExp(
    `\\bpath\\s*=\\s*"?${escapeRegExp(localizedPath)}"?\\s*;`,
  );
  const fileReference = pbxproj
    .split(/\r?\n/)
    .find((line) => line.includes('isa = PBXFileReference;') && pathPattern.test(line));
  const fileReferenceId = fileReference
    ?.match(new RegExp(`^[\\t ]*(${pbxObjectIdPattern}) /\\*`))?.[1];

  if (!fileReferenceId) {
    throw new Error(`${pbxprojPath} does not reference ${localizedPath}`);
  }
  if (!new RegExp(`\\b${fileReferenceId}\\b`).test(variantGroup.body)) {
    throw new Error(`${pbxprojPath} does not localize ${localizedPath} in InfoPlist.strings`);
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
  const tauriConfig = JSON.parse(
    readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  assertDefaultIosAppName(infoPlist, pbxproj, tauriConfig.productName, infoPlistPath);

  const variantGroup = findInfoPlistVariantGroup(pbxproj, pbxprojPath);
  assertVariantGroupIsResource(pbxproj, variantGroup.id, pbxprojPath);
  for (const locale of expectedIosLocales.keys()) {
    assertLocaleInVariantGroup(pbxproj, variantGroup, locale, pbxprojPath);
  }
}

export function prepareIosAppNames(root = projectRoot, run = spawnSync) {
  const appleRoot = path.join(root, 'src-tauri', 'gen', 'apple');
  const appDirectory = findIosAppDirectory(appleRoot);
  const sourceRoot = path.join(root, 'src-tauri', 'mobile', 'ios');

  // Tauri's project.yml always includes Sources. The English development
  // localization anchors the PBXVariantGroup; the Chinese files become its
  // localized children. Remove destinations used by older script versions so
  // incremental local builds cannot package duplicate resources.
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
    rmSync(path.join(appleRoot, appDirectory, entry.name), {
      recursive: true,
      force: true,
    });
    const destinationDir = path.join(appleRoot, 'Sources', entry.name);
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(
      path.join(sourceRoot, entry.name, 'InfoPlist.strings'),
      path.join(destinationDir, 'InfoPlist.strings'),
    );
  }

  // The generated Xcode project only knows about files that existed when
  // `tauri ios init` ran. Use the same arguments as Tauri with CI's pinned tool.
  const result = run(
    'xcodegen',
    ['generate', '--spec', path.join(appleRoot, 'project.yml')],
    { cwd: appleRoot, stdio: 'inherit' },
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
