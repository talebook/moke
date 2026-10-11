import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  computePackageDigest,
  signaturePayload,
  signPackage,
} from '../packages/moke-ext/src/commands/sign.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'moke-extension-sign-'));
  const packageDirectory = join(directory, 'dist');
  mkdirSync(packageDirectory);
  const manifest = {
    name: 'sample-extension',
    version: '1.0.0',
    display_name: 'Sample',
    publisher: {
      id: 'org.example',
      name: 'Example',
      source: 'https://example.org/extensions/sample-extension',
    },
    permissions: ['storage'],
  };
  writeFileSync(join(packageDirectory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(packageDirectory, 'ui.js'), 'console.log("safe")');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyPath = join(directory, 'publisher.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { directory, packageDirectory, keyPath, manifest, publicKey };
}

test('moke-ext signs the exact package digest with Ed25519', () => {
  const fixtureData = fixture();
  try {
    const detached = signPackage({
      directory: fixtureData.packageDirectory,
      keyPath: fixtureData.keyPath,
      keyId: 'release-2026',
    });
    assert.equal(detached.package_sha256, computePackageDigest(fixtureData.packageDirectory));
    assert.equal(
      verify(
        null,
        Buffer.from(signaturePayload(fixtureData.manifest, detached.key_id, detached.package_sha256)),
        fixtureData.publicKey,
        Buffer.from(detached.signature, 'base64'),
      ),
      true,
    );
  } finally {
    rmSync(fixtureData.directory, { recursive: true, force: true });
  }
});

test('package digest changes after payload tampering and ignores detached signature', () => {
  const fixtureData = fixture();
  try {
    const before = computePackageDigest(fixtureData.packageDirectory);
    writeFileSync(join(fixtureData.packageDirectory, 'signature.json'), '{}');
    assert.equal(computePackageDigest(fixtureData.packageDirectory), before);
    writeFileSync(join(fixtureData.packageDirectory, 'ui.js'), 'console.log("tampered")');
    assert.notEqual(computePackageDigest(fixtureData.packageDirectory), before);
    assert.deepEqual(JSON.parse(readFileSync(join(fixtureData.packageDirectory, 'signature.json'), 'utf8')), {});
  } finally {
    rmSync(fixtureData.directory, { recursive: true, force: true });
  }
});
