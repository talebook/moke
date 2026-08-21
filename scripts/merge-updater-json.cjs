// Reads .sig files produced by Tauri's createUpdaterArtifacts and builds latest.json.
// Usage: node scripts/merge-updater-json.cjs <sig-dir>
// Output: latest.json in the current directory.
//
// The .sig files are uploaded via actions/upload-artifact@v4 with a workspace-relative
// glob (e.g. src-tauri/target/release/bundle/**/*.sig), and the download-artifact step
// with merge-multiple preserves that directory structure inside <sig-dir>. So we have
// to search recursively and use the basename as the asset name.

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/merge-updater-json.cjs <sig-dir>');
  process.exit(1);
}

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

const sigFiles = findSigFiles(dir);
if (sigFiles.length === 0) {
  console.log('No .sig files found — skipping latest.json generation');
  process.exit(0);
}

// Derive version from GITHUB_REF (refs/tags/v0.1.5 → 0.1.5)
const tag = process.env.GITHUB_REF || '';
const version = tag.replace(/^refs\/tags\/v/, '') || '0.0.0';
const base = `https://github.com/talebook/moke/releases/download/v${version}`;

// Map filename to platform. Prefer .exe over .msi for windows.
function platformFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('setup.exe.sig')) return 'windows-x86_64';
  if (n.includes('en-us.msi.sig')) return 'windows-x86_64-msi'; // dedup below
  if (n.includes('aarch64.dmg.sig')) return 'darwin-aarch64';
  if (n.includes('x64.dmg.sig')) return 'darwin-x86_64';
  if (n.includes('amd64.appimage.sig')) return 'linux-x86_64';
  if (n.includes('amd64.deb.sig')) return 'linux-x86_64-deb';
  if (n.includes('aarch64.appimage.sig')) return 'linux-aarch64';
  if (n.includes('aarch64.deb.sig')) return 'linux-aarch64-deb';
  return null;
}

const platforms = {};
for (const fullPath of sigFiles) {
  const f = path.basename(fullPath);
  let plat = platformFromName(f);
  if (!plat) { console.log('  skip unknown: %s', f); continue; }

  // Dedup: prefer .exe over .msi (windows), .AppImage over .deb (linux)
  if (plat.endsWith('-msi') && platforms['windows-x86_64']) continue;
  if (plat.endsWith('-deb') && platforms['linux-x86_64']) continue;
  if (plat.endsWith('-deb') && platforms['linux-aarch64']) continue;

  const basePlat = plat.replace(/-msi|-deb/, '');
  const sig = fs.readFileSync(fullPath, 'utf-8').trim();
  const assetName = f.replace(/\.sig$/, '');
  platforms[basePlat] = { signature: sig, url: `${base}/${assetName}` };
  console.log('  %s ← %s', basePlat, f);
}

const manifest = {
  version,
  notes: '',
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('latest.json generated with %d platforms', Object.keys(platforms).length);
