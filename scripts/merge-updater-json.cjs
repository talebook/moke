// Merges per-platform Tauri updater manifests into a single latest.json.
// Each input is a JSON file with a "platforms" key containing one or more
// `{ "platform-name": { "signature": "...", "url": "..." } }` entries.
//
// Usage: node scripts/merge-updater-json.js <manifest-dir>
// Output: latest.json in the current directory.

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/merge-updater-json.cjs <manifest-dir>');
  process.exit(1);
}

let files = [];
try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* dir missing */ }
if (files.length === 0) {
  console.log('No updater manifests found — skipping latest.json generation');
  process.exit(0);
}

const manifests = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));

const merged = {
  version: manifests[0].version,
  notes: manifests[0].notes || '',
  pub_date: manifests[0].pub_date || new Date().toISOString(),
  platforms: Object.assign({}, ...manifests.map((m) => m.platforms || {})),
};

fs.writeFileSync('latest.json', JSON.stringify(merged, null, 2) + '\n');
console.log('Merged %d manifests → latest.json (%d platforms):', files.length, Object.keys(merged.platforms).length);
for (const [plat, info] of Object.entries(merged.platforms)) {
  console.log('  %s: %s', plat, info.url);
}
