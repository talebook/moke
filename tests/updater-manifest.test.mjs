import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildManifest, parseArguments } = require('../scripts/merge-updater-json.cjs');
const script = new URL('../scripts/merge-updater-json.cjs', import.meta.url);

function fixture(t, names = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-updater-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'test-signature');
  }
  return root;
}

test('stable CLI preserves GitHub release URLs and skips absent signatures', (t) => {
  const root = fixture(t);
  const run = () => spawnSync(process.execPath, [script.pathname, root], {
    cwd: root, env: { ...process.env, GITHUB_REF: 'refs/tags/v1.1.5' }, encoding: 'utf8',
  });
  assert.equal(run().status, 0);
  assert.equal(existsSync(path.join(root, 'latest.json')), false);
  writeFileSync(path.join(root, 'Moke_1.1.5_aarch64.dmg.sig'), 'signature');
  assert.equal(run().status, 0);
  const manifest = JSON.parse(readFileSync(path.join(root, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.5');
  assert.equal(manifest.platforms['darwin-aarch64'].url,
    'https://github.com/talebook/moke/releases/download/v1.1.5/Moke_1.1.5_aarch64.dmg');
});

test('updater prefers executable and AppImage independent of traversal order', (t) => {
  const root = fixture(t, [
    'z/Moke_setup.exe.sig', 'a/Moke_en-US.msi.sig',
    'z/Moke_amd64.AppImage.sig', 'a/Moke_amd64.deb.sig',
  ]);
  const manifest = buildManifest({ dir: root, version: '1.1.5', baseUrl: 'https://updates.test/assets' });
  assert.match(manifest.platforms['windows-x86_64'].url, /setup\.exe$/);
  assert.match(manifest.platforms['linux-x86_64'].url, /amd64\.AppImage$/);
});

test('updater rejects ambiguous assets, malformed signatures and unknown strict assets', (t) => {
  const root = fixture(t, ['a/Moke_setup.exe.sig', 'b/Moke_setup.exe.sig']);
  const build = (strict = false) => buildManifest({ dir: root, version: '1.1.5', baseUrl: 'https://updates.test', strict });
  assert.throws(build, /Duplicate updater assets/);
  rmSync(path.join(root, 'b/Moke_setup.exe.sig'));
  writeFileSync(path.join(root, 'a/Moke_setup.exe.sig'), 'line\nbreak');
  assert.throws(build, /Invalid updater signature/);
  writeFileSync(path.join(root, 'a/Moke_setup.exe.sig'), 'valid');
  writeFileSync(path.join(root, 'unknown.sig'), 'valid');
  assert.throws(() => build(true), /Unknown updater signature assets/);
});

test('custom updater URLs encode filenames and reject credentials and invalid versions', (t) => {
  const root = fixture(t, ['Moke space_setup.exe.sig']);
  const options = { dir: root, version: '1.1.5-dev', baseUrl: 'https://updates.test/assets/' };
  assert.equal(buildManifest(options).platforms['windows-x86_64'].url,
    'https://updates.test/assets/Moke%20space_setup.exe');
  for (const baseUrl of ['http://updates.test', 'https://user:pass@updates.test', 'https://updates.test?secret=1']) {
    assert.throws(() => buildManifest({ ...options, baseUrl }), /Updater base URL/);
  }
  assert.throws(() => buildManifest({ ...options, version: '../invalid' }), /Invalid updater version/);
  assert.throws(() => parseArguments([root, '--exclude-darwin'], {}), /Unknown or incomplete/);
  assert.throws(() => buildManifest({ ...options, ...parseArguments([root], { GITHUB_REF: 'refs/tags/preview-v1.1.5' }) }), /Invalid updater version/);
});
