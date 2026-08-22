import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUILD_ARTIFACTS = [
  '.next',
  'out',
  'tsconfig.tsbuildinfo',
  'readest/out',
  'readest/apps/readest-app/.next',
  'readest/apps/readest-app/tsconfig.tsbuildinfo',
  'src-tauri/gen/android/.gradle',
  'src-tauri/gen/android/build',
  'src-tauri/gen/android/app/build',
  'src-tauri/gen/apple/build',
  'src-tauri/gen/ohos/.hvigor',
  'src-tauri/gen/ohos/build',
  'src-tauri/gen/ohos/entry/build',
];

function removeIfPresent(target, removed) {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

function removeIncrementalDirectories(directory, removed) {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const fullPath = path.join(directory, entry.name);
    if (entry.name === 'incremental') {
      removeIfPresent(fullPath, removed);
    } else {
      removeIncrementalDirectories(fullPath, removed);
    }
  }
}

export function cleanBuildArtifacts({ projectRoot, removeRustTarget = false }) {
  const removed = [];

  for (const artifact of BUILD_ARTIFACTS) {
    removeIfPresent(path.join(projectRoot, artifact), removed);
  }

  const rustTarget = path.join(projectRoot, 'src-tauri', 'target');
  if (removeRustTarget) {
    removeIfPresent(rustTarget, removed);
  } else {
    removeIncrementalDirectories(rustTarget, removed);
  }

  return removed.map((target) => path.relative(projectRoot, target));
}

function main() {
  const args = process.argv.slice(2);
  const unsupported = args.filter((arg) => arg !== '--rust');
  if (unsupported.length > 0) {
    throw new Error(`Unsupported option(s): ${unsupported.join(', ')}`);
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const removeRustTarget = args.includes('--rust');
  const removed = cleanBuildArtifacts({ projectRoot, removeRustTarget });

  if (removed.length === 0) {
    console.log('Build cleanup: nothing to remove.');
    return;
  }

  console.log(`Build cleanup: removed ${removed.length} path(s):`);
  for (const target of removed) console.log(`- ${target}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
