import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const provenancePath = 'docs/vendor-plugin-provenance.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inventory(directory) {
  const files = {};
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Unexpected symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
      else {
        assert.ok(entry.isFile(), `Unexpected non-file: ${file}`);
        files[path.relative(directory, file).split(path.sep).join('/')] = sha256(readFileSync(file));
      }
    }
  }
  visit(directory);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function checkInventory(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected).sort(), `${label}: file inventory changed`);
  for (const [file, hash] of Object.entries(expected)) {
    assert.equal(actual[file], hash, `${label}/${file}: unexpected content (review provenance before updating)`);
  }
}

// Raw-byte hashes lock all code, build scripts, manifests and resources. No cfg
// heuristic or broad whitespace normalization can exempt a desktop change.
export function verifyPluginFiles(plugin, root = projectRoot) {
  const directory = path.join(root, plugin.path);
  checkInventory(inventory(directory), plugin.localFiles, plugin.name);
  const cargo = readFileSync(path.join(directory, 'Cargo.toml'), 'utf8');
  assert.match(cargo, new RegExp(`^name = "${plugin.name}"$`, 'm'));
  assert.match(cargo, new RegExp(`^version = "${plugin.version.replaceAll('.', '\\.')}"$`, 'm'));
}

function verifyDifferenceList(plugin) {
  const differences = [...new Set([
    ...Object.keys(plugin.upstreamFiles), ...Object.keys(plugin.localFiles),
  ])].sort().filter((file) => plugin.upstreamFiles[file] !== plugin.localFiles[file]);
  const allowed = plugin.allowedDifferences.map((entry) => entry.path);
  assert.deepEqual(allowed, differences, `${plugin.name}: exact difference allowlist changed`);
  for (const change of plugin.allowedDifferences) {
    const kind = !(change.path in plugin.upstreamFiles) ? 'added'
      : !(change.path in plugin.localFiles) ? 'omitted' : 'modified';
    assert.equal(change.kind, kind, `${plugin.name}/${change.path}: difference kind changed`);
    assert.ok(change.reason.length > 0, `${plugin.name}/${change.path}: missing review reason`);
  }
  const delta = differences.map((file) => [
    file, plugin.upstreamFiles[file] ?? null, plugin.localFiles[file] ?? null,
  ]);
  assert.equal(sha256(JSON.stringify(delta)), plugin.deltaSha256, `${plugin.name}: exact delta hash changed`);
  for (const file of plugin.whitespaceOnlyPaths) {
    assert.ok(plugin.upstreamFiles[file] && plugin.localFiles[file] && differences.includes(file),
      `${plugin.name}/${file}: invalid whitespace-only declaration`);
  }
  for (const files of [plugin.upstreamFiles, plugin.localFiles]) {
    for (const [file, hash] of Object.entries(files)) {
      assert.ok(!path.posix.isAbsolute(file) && !file.split('/').includes('..') && !file.includes('\\'),
        `${plugin.name}: unsafe file path`);
      assert.match(hash, /^[a-f0-9]{64}$/, `${plugin.name}/${file}: invalid SHA-256`);
    }
  }
}

function verifyCargoSelection(manifest, root) {
  const cargo = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const patches = cargo.split('[patch.crates-io]')[1]?.split(/\n\[/)[0] ?? '';
  const selected = [...patches.matchAll(/^(tauri-plugin-[\w-]+) = \{ path = "\.\.\/(vendor\/(?:tauri-plugin-[^"/]+|ohos-plugins\/plugins\/[^"/]+))" \}$/gm)]
    .map((match) => [match[1], match[2]]).sort();
  const declaredNames = [...patches.matchAll(/^\s*["']?(tauri-plugin-[\w-]+)["']?(?=[\s.=])/gm)]
    .map((match) => match[1]).sort();
  assert.doesNotMatch(cargo, /^\s*\[patch\.crates-io\.["']?tauri-plugin-/m,
    'Unsupported Cargo plugin patch format: nested plugin tables must not be skipped');
  assert.deepEqual(selected.map(([name]) => name), declaredNames,
    'Unsupported Cargo plugin patch format: every entry must be explicitly covered, never skipped');
  assert.deepEqual(manifest.plugins.map((plugin) => [plugin.name, plugin.path]).sort(), selected,
    'Provenance must cover every root vendor plugin patch, which applies on every target');
  const locked = readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8').split('[[package]]');
  for (const plugin of manifest.plugins) {
    const entries = locked.filter((entry) => entry.includes(`\nname = "${plugin.name}"\n`));
    assert.equal(entries.length, 1, `${plugin.name}: expected one locked package`);
    assert.ok(entries[0].includes(`\nversion = "${plugin.version}"\n`), `${plugin.name}: locked version changed`);
    assert.doesNotMatch(entries[0], /^source = /m, `${plugin.name}: expected the reviewed local patch`);
    if (plugin.submodule) {
      const actual = execFileSync('git', ['-C', path.join(root, plugin.submodule.path), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const indexed = execFileSync('git', ['-C', root, 'rev-parse', `:${plugin.submodule.path}`], { encoding: 'utf8' }).trim();
      assert.equal(actual, plugin.submodule.sha, `${plugin.name}: submodule checkout changed`);
      assert.equal(indexed, plugin.submodule.sha, `${plugin.name}: submodule gitlink changed`);
    }
  }
}

async function verifyRegistryArchive(plugin, root) {
  const expectedUrl = `https://static.crates.io/crates/${plugin.name}/${plugin.name}-${plugin.version}.crate`;
  assert.equal(plugin.upstream.archiveUrl, expectedUrl, `${plugin.name}: unexpected registry URL`);
  let response;
  try {
    response = await fetch(expectedUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`${plugin.name}: registry fetch failed (${error.cause?.code ?? error.message})`, { cause: error });
  }
  assert.ok(response.ok, `${plugin.name}: registry download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), plugin.upstream.archiveSha256, `${plugin.name}: registry archive checksum changed`);
  const temporary = mkdtempSync(path.join(tmpdir(), 'moke-plugin-provenance-'));
  try {
    const archive = path.join(temporary, 'source.crate');
    writeFileSync(archive, bytes);
    const prefix = `${plugin.name}-${plugin.version}/`;
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(members.every((member) => member.startsWith(prefix) && !member.split('/').includes('..')),
      `${plugin.name}: unsafe archive member`);
    execFileSync('tar', ['-xzf', archive, '-C', temporary]);
    const source = path.join(temporary, `${plugin.name}-${plugin.version}`);
    checkInventory(inventory(source), plugin.upstreamFiles, `${plugin.name} registry archive`);
    const vcs = JSON.parse(readFileSync(path.join(source, '.cargo_vcs_info.json'), 'utf8'));
    assert.equal(vcs.git.sha1, plugin.upstream.gitCommit, `${plugin.name}: upstream commit changed`);
    assert.equal(vcs.path_in_vcs, plugin.upstream.pathInRepository, `${plugin.name}: upstream directory changed`);
    for (const file of plugin.whitespaceOnlyPaths) {
      // This proves only the seven listed historical cleanups. Local integrity
      // is still checked against exact raw bytes, including whitespace.
      const normalize = (buffer) => buffer.toString('utf8').replace(/[ \t]+(?=\r?$)/gm, '');
      assert.equal(normalize(readFileSync(path.join(source, file))),
        normalize(readFileSync(path.join(root, plugin.path, file))),
        `${plugin.name}/${file}: change exceeds the declared trailing-whitespace cleanup`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function verifyVendorPluginProvenance({ root = projectRoot, verifyRegistry = false } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(root, provenancePath), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.hashAlgorithm, 'sha256');
  verifyCargoSelection(manifest, root);
  for (const plugin of manifest.plugins) {
    verifyDifferenceList(plugin);
    verifyPluginFiles(plugin, root);
    if (verifyRegistry) await verifyRegistryArchive(plugin, root);
  }
  return { plugins: manifest.plugins.length,
    localFiles: manifest.plugins.reduce((total, plugin) => total + Object.keys(plugin.localFiles).length, 0),
    registryVerified: verifyRegistry };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.slice(2).every((arg) => arg === '--verify-registry'),
      'Usage: node scripts/check-vendor-plugin-provenance.mjs [--verify-registry]');
    const result = await verifyVendorPluginProvenance({ verifyRegistry: process.argv.includes('--verify-registry') });
    console.log(`Verified ${result.plugins} plugin patches, ${result.localFiles} local files${result.registryVerified ? ' and their published crates.io archives' : ' (offline; registry archives not fetched)'}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
