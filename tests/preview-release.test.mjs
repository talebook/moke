import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPreviewReleaseConfig } from '../scripts/prepare-preview-release-config.mjs';

const require = createRequire(import.meta.url);
const { buildManifest, parseArguments } = require('../scripts/merge-updater-json.cjs');
const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const previewConfig = readJson('src-tauri/tauri.preview.conf.json');
const stableConfig = readJson('src-tauri/tauri.conf.json');
const rawPreviewKey = Buffer.alloc(42);
rawPreviewKey[0] = 0x45;
rawPreviewKey[1] = 0x64;
const previewPublicKey = Buffer.from(
  `untrusted comment: minisign public key: PREVIEW\n${rawPreviewKey.toString('base64')}\n`,
).toString('base64');

test('Preview release overlay requires a dedicated HTTPS updater identity', () => {
  const environment = {
    MOKE_PREVIEW_UPDATER_ENDPOINT:
      'https://updates.example.test/v1/preview/{{target}}/{{arch}}/{{current_version}}',
    MOKE_PREVIEW_UPDATER_PUBLIC_KEY: previewPublicKey,
  };
  const config = createPreviewReleaseConfig({ environment, previewConfig, stableConfig });

  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.build.beforeBuildCommand, '');
  assert.deepEqual(config.plugins.updater.endpoints, [environment.MOKE_PREVIEW_UPDATER_ENDPOINT]);
  assert.equal(config.plugins.updater.pubkey, previewPublicKey);
  assert.equal(config.identifier, 'org.houheya.moke.preview');
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE|SIGNING_PRIVATE_KEY/);

  assert.throws(
    () => createPreviewReleaseConfig({ environment: {}, previewConfig, stableConfig }),
    /MOKE_PREVIEW_UPDATER_ENDPOINT is required/,
  );
  assert.throws(
    () => createPreviewReleaseConfig({
      environment: { ...environment, MOKE_PREVIEW_UPDATER_ENDPOINT: 'http://updates.example.test' },
      previewConfig,
      stableConfig,
    }),
    /must be an HTTPS URL/,
  );
  assert.throws(
    () => createPreviewReleaseConfig({
      environment: {
        ...environment,
        MOKE_PREVIEW_UPDATER_PUBLIC_KEY: stableConfig.plugins.updater.pubkey,
      },
      previewConfig,
      stableConfig,
    }),
    /must not reuse the Stable signing identity/,
  );
});

test('strict updater manifest is deterministic and rejects ambiguous assets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moke-preview-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'linux'));
  mkdirSync(join(root, 'macos'));
  writeFileSync(join(root, 'linux', 'Moke_1.2.3_amd64.AppImage.sig'), 'signed-appimage');
  writeFileSync(join(root, 'linux', 'Moke_1.2.3_amd64.deb.sig'), 'signed-deb');
  writeFileSync(join(root, 'macos', 'Moke_1.2.3_aarch64.dmg.sig'), 'signed-dmg');

  const manifest = buildManifest({
    dir: root,
    version: '1.2.3',
    baseUrl: 'https://updates.example.test/v1/preview/artifacts/1.2.3',
    strict: true,
    excludeDarwin: true,
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'signed-appimage');
  assert.match(manifest.platforms['linux-x86_64'].url, /^https:\/\/updates\.example\.test\//);
  assert.equal(manifest.platforms['darwin-aarch64'], undefined);
  assert.equal(manifest.platforms['darwin-x86_64'], undefined);

  writeFileSync(join(root, 'linux', 'Other_1.2.3_amd64.AppImage.sig'), 'duplicate');
  assert.throws(
    () => buildManifest({
      dir: root,
      version: '1.2.3',
      baseUrl: 'https://updates.example.test/v1/preview/artifacts/1.2.3',
      strict: true,
      excludeDarwin: true,
    }),
    /Duplicate updater assets/,
  );
});

test('Preview manifest CLI explicitly excludes Darwin updater artifacts', () => {
  const options = parseArguments([
    'preview-updater-artifacts',
    '--version', '1.2.3',
    '--base-url', 'https://updates.example.test/v1/preview/artifacts/1.2.3',
    '--exclude-darwin',
    '--strict',
  ], {});
  assert.equal(options.excludeDarwin, true);
  assert.equal(options.strict, true);
});

test('Preview release workflow isolates the signing key and never falls back to Stable secrets', () => {
  const workflow = readText('.github/workflows/preview-release.yml');
  const buildJob = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  sign:'));
  const signJob = workflow.slice(workflow.indexOf('  sign:'), workflow.indexOf('  manifest:'));
  assert.match(workflow, /secrets\.PREVIEW_TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /MOKE_PREVIEW_ENTITLEMENT_URL/);
  assert.match(workflow, /--features preview/);
  assert.match(workflow, /preview:release-config/);
  assert.match(workflow, /--strict/);
  assert.match(workflow, /--exclude-darwin/);
  assert.match(workflow, /NEXT_PUBLIC_PREVIEW_UPDATER_ENABLED: \$\{\{ matrix\.platform != 'macos' \}\}/);
  assert.doesNotMatch(buildJob, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(buildJob, /contents: read/);
  assert.match(signJob, /checks out no repository source/);
  assert.match(signJob, /@tauri-apps\/cli@2\.11\.3/);
  assert.match(signJob, /signer sign/);
  assert.match(signJob, /contents: write/);
  assert.doesNotMatch(signJob, /-name '\*\.dmg'/);
  assert.match(signJob, /preview-signed-artifacts\/\*\*\/\*\.dmg/);
  assert.doesNotMatch(signJob, /actions\/checkout/);
  assert.doesNotMatch(workflow, /uses: [^\s]+@(v\d+|stable)\s*$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY\s*}}/);
});
