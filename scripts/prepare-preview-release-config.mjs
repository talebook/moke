import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = resolve(repositoryRoot, 'src-tauri/tauri.preview.conf.json');
const defaultStableSource = resolve(repositoryRoot, 'src-tauri/tauri.conf.json');
const defaultOutput = resolve(
  repositoryRoot,
  'src-tauri/target/preview-release/tauri.release.conf.json',
);

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for a Preview release`);
  return value;
}

function validateHttpsUrl(value, name) {
  let url;
  const withoutKnownPlaceholders = value.replace(
    /\{\{(?:target|arch|current_version)\}\}/g,
    'placeholder',
  );
  if (/[{}]/.test(withoutKnownPlaceholders)) {
    throw new Error(`${name} contains an unsupported updater placeholder`);
  }
  try {
    url = new URL(withoutKnownPlaceholders);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || url.search
  ) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return value;
}

function validateUpdaterPublicKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 4096) {
    throw new Error('MOKE_PREVIEW_UPDATER_PUBLIC_KEY must be a base64-encoded minisign public key');
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error();
    decoded = bytes.toString('utf8');
  } catch {
    throw new Error('MOKE_PREVIEW_UPDATER_PUBLIC_KEY must be valid base64');
  }
  const lines = decoded.trim().split(/\r?\n/);
  let keyBytes;
  try {
    keyBytes = Buffer.from(lines[1] ?? '', 'base64');
  } catch {
    keyBytes = Buffer.alloc(0);
  }
  if (
    lines.length !== 2
    || !lines[0].startsWith('untrusted comment: minisign public key')
    || !/^RW[A-Za-z0-9+/=]+$/.test(lines[1])
    || keyBytes.length !== 42
    || keyBytes.toString('base64') !== lines[1]
  ) {
    throw new Error('MOKE_PREVIEW_UPDATER_PUBLIC_KEY is not a minisign public key');
  }
  return value;
}

export function createPreviewReleaseConfig({
  environment = process.env,
  previewConfig,
  stableConfig,
}) {
  const endpoint = validateHttpsUrl(
    requiredValue(environment, 'MOKE_PREVIEW_UPDATER_ENDPOINT'),
    'MOKE_PREVIEW_UPDATER_ENDPOINT',
  );
  const pubkey = validateUpdaterPublicKey(
    requiredValue(environment, 'MOKE_PREVIEW_UPDATER_PUBLIC_KEY'),
  );

  const stableEndpoints = stableConfig?.plugins?.updater?.endpoints ?? [];
  const stablePubkey = stableConfig?.plugins?.updater?.pubkey;
  if (stableEndpoints.includes(endpoint)) {
    throw new Error('Preview updater endpoint must not reuse the Stable updater endpoint');
  }
  if (stablePubkey && stablePubkey === pubkey) {
    throw new Error('Preview updater public key must not reuse the Stable signing identity');
  }
  if (previewConfig.identifier !== 'org.houheya.moke.preview') {
    throw new Error('Refusing to generate a Preview release from a non-Preview app identity');
  }

  return {
    ...previewConfig,
    bundle: {
      ...previewConfig.bundle,
      createUpdaterArtifacts: true,
    },
    plugins: {
      ...previewConfig.plugins,
      updater: {
        ...previewConfig.plugins?.updater,
        pubkey,
        endpoints: [endpoint],
      },
    },
  };
}

export function preparePreviewReleaseConfig({
  environment = process.env,
  source = defaultSource,
  stableSource = defaultStableSource,
  output = defaultOutput,
} = {}) {
  const previewConfig = JSON.parse(readFileSync(source, 'utf8'));
  const stableConfig = JSON.parse(readFileSync(stableSource, 'utf8'));
  const config = createPreviewReleaseConfig({ environment, previewConfig, stableConfig });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return output;
}

function parseOutputArgument(argv) {
  const index = argv.indexOf('--output');
  if (index === -1) return defaultOutput;
  if (!argv[index + 1]) throw new Error('--output requires a path');
  return resolve(argv[index + 1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = preparePreviewReleaseConfig({ output: parseOutputArgument(process.argv.slice(2)) });
    console.log(`Preview release config written to ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
