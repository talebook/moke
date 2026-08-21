import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ARTIFACT_ROOTS = [
  'src-tauri/target/release/bundle',
  'src-tauri/gen/android/app/build/outputs/apk',
  'src-tauri/gen/apple/build',
  'src-tauri/gen/ohos',
  'ios-release-artifacts',
];

const ARTIFACT_SUFFIXES = [
  '.app',
  '.appimage',
  '.apk',
  '.deb',
  '.dmg',
  '.exe',
  '.hap',
  '.ipa',
  '.msi',
  '.sig',
];

function isUploadArtifact(name) {
  const lowerName = name.toLowerCase();
  return ARTIFACT_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function normalizeArtifactTree(root, renamed) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name);
    const isAppBundle = entry.isDirectory() && entry.name.toLowerCase().endsWith('.app');

    if (entry.name.includes('墨客') && isUploadArtifact(entry.name)) {
      const destination = path.join(root, entry.name.replaceAll('墨客', 'moke'));
      if (existsSync(destination)) {
        throw new Error(`Cannot rename artifact because the destination already exists: ${destination}`);
      }
      renameSync(source, destination);
      renamed.push({ from: source, to: destination });
      continue;
    }

    // An .app bundle is a signed upload artifact. Never rename files inside it.
    if (entry.isDirectory() && !isAppBundle) {
      normalizeArtifactTree(source, renamed);
    }
  }
}

export function normalizeArtifactNames(projectRoot = process.cwd(), artifactRoots = DEFAULT_ARTIFACT_ROOTS) {
  const renamed = [];

  for (const relativeRoot of artifactRoots) {
    const root = path.resolve(projectRoot, relativeRoot);
    if (existsSync(root)) {
      normalizeArtifactTree(root, renamed);
    }
  }

  return renamed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const renamed = normalizeArtifactNames();
  for (const artifact of renamed) {
    console.log(`Renamed ${path.relative(process.cwd(), artifact.from)} -> ${path.relative(process.cwd(), artifact.to)}`);
  }
  console.log(`Normalized ${renamed.length} artifact filename(s).`);
}
