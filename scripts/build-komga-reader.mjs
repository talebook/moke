import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const provenance = JSON.parse(readFileSync(new URL('../vendor/komga-reader/source.json', import.meta.url), 'utf8'));
const patch = resolve(root, 'vendor/komga-reader/continuous-scroll.patch');
const output = resolve(root, 'public/vendor/komga-reader');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function verify(path, expected) {
  if (sha256(path) !== expected) throw new Error(`Checksum mismatch: ${path}`);
}

export function checkKomgaReader() {
  verify(patch, provenance.patchSha256);
  verify(resolve(output, 'VERSION'), provenance.versionSha256);
  for (const [file, digest] of Object.entries(provenance.patched)) verify(resolve(output, file), digest);
  for (const [file, digest] of Object.entries(provenance.notices)) verify(resolve(output, file), digest);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

// The supplied archive is the exact pinned source, never a floating branch.
// All extraction, npm cache and builds stay inside the caller's own space.
function build(archive, workspace) {
  verify(archive, provenance.archiveSha256);
  verify(patch, provenance.patchSha256);
  mkdirSync(workspace, { recursive: true });
  const source = mkdtempSync(resolve(workspace, 'komga-'));
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', source], root);
  verify(resolve(source, 'package-lock.json'), provenance.lockSha256);
  verify(resolve(source, 'src/components/ComicReader.vue'), provenance.componentSha256);
  for (const [file, digest] of Object.entries(provenance.notices)) verify(resolve(source, file), digest);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', resolve(workspace, 'npm-cache')], source);
  // Establish byte-identical reproduction of the shipped baseline before patching.
  run('npm', ['run', 'build:browser'], source);
  for (const [file, digest] of Object.entries(provenance.baseline)) verify(resolve(source, 'browser-dist', file), digest);
  run('git', ['apply', '--check', '--whitespace=error', patch], source);
  run('git', ['apply', '--whitespace=error', patch], source);
  run('npm', ['run', 'build:browser'], source);
  for (const [file, digest] of Object.entries(provenance.patched)) verify(resolve(source, 'browser-dist', file), digest);
  // Copy only verified outputs; license files and upstream VERSION stay intact.
  for (const file of Object.keys(provenance.patched)) copyFileSync(resolve(source, 'browser-dist', file), resolve(output, file));
  checkKomgaReader();
  console.log(`Verified komga-reader ${provenance.commit} + continuous-scroll.patch`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    checkKomgaReader();
    console.log('komga-reader resource checksums match the pinned source and local patch');
  } else if (args.length === 4 && args[0] === '--archive' && args[2] === '--workdir') {
    build(resolve(args[1]), resolve(args[3]));
  } else throw new Error('Usage: node scripts/build-komga-reader.mjs --check | --archive <pinned.tar.gz> --workdir <own-build-directory>');
}
