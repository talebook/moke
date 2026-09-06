// moke-ext package: portable ZIP with manifest.json directly at archive root.
import { createWriteStream, lstatSync, readFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import yazl from 'yazl';
import { normalizeNativePath, reservedPackagePath } from '../package-path.js';
import { validateManifest } from './validate.js';
import { computePackageDigest } from './sign.js';

export async function packageExtension(directory, output) {
  const root = resolve(directory);
  const raw = readFileSync(join(root, 'manifest.json'), 'utf8');
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Manifest exceeds 64 KiB');
  const manifest = JSON.parse(raw);
  validateManifest(manifest);
  const destination = resolve(output ?? `${manifest.name}-${manifest.version}.zip`);
  const relativeOutput = relative(root, destination);
  if (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..') throw new Error('ZIP output must be outside package directory');
  const files = [];
  const seen = new Map();
  let total = 0;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = normalizeNativePath(relative(root, path), sep);
      if (reservedPackagePath(name)) throw new Error(`Remove host state/legacy installer before packaging: ${name}`);
      if (seen.has(name.toUpperCase())) throw new Error(`Case collision: ${name}`);
      seen.set(name.toUpperCase(), name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Links/special files are forbidden: ${name}`);
      if (stat.isDirectory()) visit(path);
      else {
        total += stat.size;
        if (stat.size > 256 * 1024 * 1024 || total > 1024 * 1024 * 1024) throw new Error('Package exceeds safety limits');
        files.push({ path, name });
        if (files.length > 10000) throw new Error('Package exceeds 10000 files');
      }
    }
  }
  visit(root);
  if (manifest.entry?.backend) {
    if (!manifest.entry.backend.targets?.length) throw new Error('Declare entry.backend.targets before packaging');
    if (!files.some(f => f.name === manifest.entry.backend.executable)) throw new Error('Backend executable is missing');
    const signature = JSON.parse(readFileSync(join(root, 'signature.json'), 'utf8'));
    if (signature.package_sha256 !== computePackageDigest(root)) throw new Error('Package changed after signing; sign dist/ again');
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  try {
    const done = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    for (const file of files.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))) {
      zip.addFile(file.path, file.name, { mode: 0o100644, mtime: new Date('2026-01-01T00:00:00Z'), forceDosTimestamp: true });
    }
    zip.end();
    await done;
    if (lstatSync(temporary).size > 512 * 1024 * 1024) throw new Error('ZIP exceeds 512 MiB');
    renameSync(temporary, destination);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return destination;
}
export default async function pack(args = []) {
  if (args.length) throw new Error('Usage: moke-ext package (build and sign dist/ first)');
  console.log(`Package created: ${await packageExtension('dist')}`);
}
