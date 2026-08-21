import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function prepareAndroidAppNames(root = projectRoot) {
  const source = path.join(root, 'src-tauri', 'mobile', 'android', 'values-en', 'strings.xml');
  const destinationDir = path.join(
    root,
    'src-tauri',
    'gen',
    'android',
    'app',
    'src',
    'main',
    'res',
    'values-en',
  );
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(source, path.join(destinationDir, 'strings.xml'));
}

export function prepareIosAppNames(root = projectRoot, run = spawnSync) {
  const appleRoot = path.join(root, 'src-tauri', 'gen', 'apple');
  const appDirectory = readdirSync(appleRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('_iOS'))?.name;

  if (!appDirectory) {
    throw new Error(`Generated iOS app directory was not found under ${appleRoot}`);
  }

  const source = path.join(root, 'src-tauri', 'mobile', 'ios', 'en.lproj', 'InfoPlist.strings');
  const destinationDir = path.join(appleRoot, appDirectory, 'en.lproj');
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(source, path.join(destinationDir, 'InfoPlist.strings'));

  // The generated Xcode project only knows about files that existed when
  // `tauri ios init` ran. Regenerate it now so InfoPlist.strings is bundled.
  const result = run(
    'xcodegen',
    ['generate', '--spec', path.join(appleRoot, 'project.yml')],
    { cwd: appleRoot, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`xcodegen exited with status ${result.status}`);
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const platform = process.argv[2];
  if (platform === 'android') {
    prepareAndroidAppNames();
    console.log('[app-names] Added Android English app name: Moke');
  } else if (platform === 'ios') {
    prepareIosAppNames();
    console.log('[app-names] Added iOS English app name: Moke');
  } else {
    console.error('Usage: node scripts/prepare-mobile-app-names.mjs <android|ios>');
    process.exitCode = 1;
  }
}
