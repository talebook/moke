// moke-ext build: prepare one native target, with an explicit manifest declaration.
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateManifest } from './validate.js';

export default function build() {
  const cwd = process.cwd();
  const manifest = validateManifest(JSON.parse(readFileSync(join(cwd, 'manifest.json'), 'utf8')));
  const dist = join(cwd, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist);
  for (const asset of ['icon.png', 'ui']) {
    if (existsSync(join(cwd, asset))) cpSync(join(cwd, asset), join(dist, asset), { recursive: true });
  }
  if (manifest.entry?.backend && existsSync(join(cwd, 'backend', 'Cargo.toml'))) {
    const result = spawnSync('cargo', ['build', '--release', '--message-format=json'], { cwd: join(cwd, 'backend'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Backend build failed: ${result.stderr || result.error}`);
    const artifacts = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(message => message.reason === 'compiler-artifact' && message.executable && message.target.kind.includes('bin'));
    const expected = manifest.entry.backend.executable.replace(/\.exe$/i, '');
    const artifact = artifacts.find(a => a.target.name === expected) ?? (artifacts.length === 1 ? artifacts[0] : null);
    if (!artifact) throw new Error('Cannot identify backend binary; configure entry.backend.executable');
    cpSync(artifact.executable, join(dist, manifest.entry.backend.executable));
    const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    if (!platform || !arch) throw new Error('Unsupported native target');
    manifest.entry.backend.targets = [`${platform}-${arch}`];
  }
  writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('dist/ ready. Sign with moke-ext sign, then run moke-ext package to create an importable ZIP.');
}
