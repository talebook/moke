import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanBuildArtifacts } from '../scripts/clean-build-artifacts.mjs';

test('Rust dev profile avoids the large incremental object cache', () => {
  const cargoConfig = readFileSync(new URL('../src-tauri/.cargo/config.toml', import.meta.url), 'utf8');

  assert.match(cargoConfig, /\[profile\.dev\][\s\S]*codegen-units = 16/);
  assert.match(cargoConfig, /\[profile\.dev\][\s\S]*incremental = false/);
  assert.match(cargoConfig, /\[profile\.dev\][\s\S]*debug = 1/);
});

function createFile(root, relativePath) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, 'build artifact');
}

test('default cleanup removes frontend outputs and Rust incremental caches', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'moke-build-clean-'));
  createFile(root, '.next/cache/frontend');
  createFile(root, 'out/index.html');
  createFile(root, 'readest/out/readest/index.html');
  createFile(root, 'readest/apps/readest-app/.next/cache/reader');
  createFile(root, 'src-tauri/gen/android/app/build/outputs/app.apk');
  createFile(root, 'src-tauri/gen/apple/build/Moke.app/binary');
  createFile(root, 'src-tauri/gen/ohos/entry/build/default/outputs/app.hap');
  createFile(root, 'src-tauri/target/debug/incremental/moke/cache');
  createFile(root, 'src-tauri/target/x86_64-pc-windows-msvc/debug/incremental/moke/cache');
  createFile(root, 'src-tauri/target/debug/deps/libmoke.rlib');

  const removed = cleanBuildArtifacts({ projectRoot: root });

  assert.deepEqual(removed.sort(), [
    '.next',
    'out',
    'readest/apps/readest-app/.next',
    'readest/out',
    'src-tauri/gen/android/app/build',
    'src-tauri/gen/apple/build',
    'src-tauri/gen/ohos/entry/build',
    'src-tauri/target/debug/incremental',
    'src-tauri/target/x86_64-pc-windows-msvc/debug/incremental',
  ]);
  assert.equal(existsSync(path.join(root, 'src-tauri/target/debug/deps/libmoke.rlib')), true);
});

test('full cleanup also removes the complete Rust target directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'moke-build-clean-full-'));
  createFile(root, 'src-tauri/target/release/moke');

  const removed = cleanBuildArtifacts({ projectRoot: root, removeRustTarget: true });

  assert.deepEqual(removed, ['src-tauri/target']);
  assert.equal(existsSync(path.join(root, 'src-tauri/target')), false);
});
