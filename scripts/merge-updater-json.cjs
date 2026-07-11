// Reads .sig files produced by Tauri's createUpdaterArtifacts and builds latest.json.
// Usage: node scripts/merge-updater-json.cjs <sig-dir>
// Output: latest.json in the current directory.

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/merge-updater-json.cjs <sig-dir>');
  process.exit(1);
}

let files = [];
try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.sig')); } catch { /* dir missing */ }
if (files.length === 0) {
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
for (const f of files) {
  let plat = platformFromName(f);
  if (!plat) { console.log('  skip unknown: %s', f); continue; }

  // Dedup: prefer .exe over .msi (windows), .AppImage over .deb (linux)
  if (plat.endsWith('-msi') && platforms['windows-x86_64']) continue;
  if (plat.endsWith('-deb') && platforms['linux-x86_64']) continue;
  if (plat.endsWith('-deb') && platforms['linux-aarch64']) continue;

  const basePlat = plat.replace(/-msi|-deb/, '');
  const sig = fs.readFileSync(path.join(dir, f), 'utf-8').trim();
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
