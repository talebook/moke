// Reads .sig files produced by the isolated Preview signer and builds latest.json.
// Stable usage remains: node scripts/merge-updater-json.cjs <sig-dir>
// Preview releases must pass an explicit version and authenticated download base:
//   node scripts/merge-updater-json.cjs <sig-dir> --version 1.2.3 \
//     --base-url https://updates.example.test/v1/preview/artifacts/1.2.3 \
//     --exclude-darwin --strict
//
// The .sig files are uploaded via actions/upload-artifact@v4 with a workspace-relative
// glob (e.g. src-tauri/target/release/bundle/**/*.sig), and the download-artifact step
// with merge-multiple preserves that directory structure inside <sig-dir>. So we have
// to search recursively and use the basename as the asset name.

const fs = require('fs');
const path = require('path');

function findSigFiles(root) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...findSigFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.sig')) {
      out.push(full);
    }
  }
  return out;
}

// Map filename to platform. Prefer .exe over .msi for windows.
function platformFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('setup.exe.sig')) return { platform: 'windows-x86_64', priority: 20 };
  if (n.includes('en-us.msi.sig')) return { platform: 'windows-x86_64', priority: 10 };
  if (n.includes('aarch64.dmg.sig')) return { platform: 'darwin-aarch64', priority: 20 };
  if (n.includes('x64.dmg.sig')) return { platform: 'darwin-x86_64', priority: 20 };
  if (n.includes('amd64.appimage.sig')) return { platform: 'linux-x86_64', priority: 20 };
  if (n.includes('amd64.deb.sig')) return { platform: 'linux-x86_64', priority: 10 };
  if (n.includes('aarch64.appimage.sig')) return { platform: 'linux-aarch64', priority: 20 };
  if (n.includes('aarch64.deb.sig')) return { platform: 'linux-aarch64', priority: 10 };
  return null;
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid updater version: ${version}`);
  }
  return version;
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid updater base URL: ${value}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Updater base URL must use HTTPS without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

function versionFromEnvironment(environment) {
  const ref = environment.GITHUB_REF || '';
  const tag = ref.replace(/^refs\/tags\//, '');
  return tag.replace(/^(?:preview-)?v/, '') || '0.0.0';
}

function buildManifest({
  dir,
  version,
  baseUrl,
  strict = false,
  excludeDarwin = false,
  now = new Date(),
}) {
  const checkedVersion = validateVersion(version);
  const checkedBaseUrl = validateBaseUrl(baseUrl);
  const sigFiles = findSigFiles(dir).sort();
  if (sigFiles.length === 0) throw new Error('No .sig files found');

  const selected = new Map();
  const unknown = [];
  for (const fullPath of sigFiles) {
    const filename = path.basename(fullPath);
    const candidate = platformFromName(filename);
    if (!candidate) {
      unknown.push(filename);
      continue;
    }
    if (excludeDarwin && candidate.platform.startsWith('darwin-')) continue;
    const previous = selected.get(candidate.platform);
    if (previous && previous.priority === candidate.priority) {
      throw new Error(
        `Duplicate updater assets for ${candidate.platform}: ${previous.filename}, ${filename}`,
      );
    }
    if (!previous || candidate.priority > previous.priority) {
      selected.set(candidate.platform, { ...candidate, filename, fullPath });
    }
  }
  if (strict && unknown.length > 0) {
    throw new Error(`Unknown updater signature assets: ${unknown.join(', ')}`);
  }
  if (selected.size === 0) throw new Error('No recognized updater signature assets found');

  const platforms = {};
  for (const [platform, candidate] of [...selected.entries()].sort()) {
    const signature = fs.readFileSync(candidate.fullPath, 'utf8').trim();
    if (!signature || signature.length > 16 * 1024 || /[\r\n]/.test(signature)) {
      throw new Error(`Invalid updater signature file: ${candidate.filename}`);
    }
    const assetName = candidate.filename.replace(/\.sig$/, '');
    platforms[platform] = {
      signature,
      url: `${checkedBaseUrl}/${encodeURIComponent(assetName)}`,
    };
  }

  return {
    version: checkedVersion,
    notes: '',
    pub_date: now.toISOString(),
    platforms,
  };
}

function parseArguments(argv, environment) {
  const dir = argv[0];
  if (!dir) throw new Error('Usage: node scripts/merge-updater-json.cjs <sig-dir> [options]');
  const options = { dir, strict: false, excludeDarwin: false, output: 'latest.json' };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--strict') { options.strict = true; continue; }
    if (argument === '--exclude-darwin') { options.excludeDarwin = true; continue; }
    if (!['--version', '--base-url', '--output'].includes(argument) || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    const key = argument === '--base-url' ? 'baseUrl' : argument.slice(2);
    options[key] = argv[index + 1];
    index += 1;
  }
  options.version ??= versionFromEnvironment(environment);
  options.baseUrl ??= `https://github.com/talebook/moke/releases/download/v${options.version}`;
  return options;
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2), process.env);
    const manifest = buildManifest(options);
    fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      '%s generated with %d platforms',
      options.output,
      Object.keys(manifest.platforms).length,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { buildManifest, parseArguments, platformFromName, validateBaseUrl, validateVersion };
