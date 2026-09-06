// moke-ext init <name> — scaffold a new extension project

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_TEMPLATE = (name, display) => JSON.stringify({
  name,
  version: '1.0.0',
  api_version: '1',
  display_name: display,
  description: 'TODO: describe your extension',
  author: 'TODO: your name',
  publisher: {
    id: 'example.publisher',
    name: 'TODO: publisher name',
    source: `https://example.invalid/moke-extensions/${name}`,
  },
  entry: { ui_port: 0 },
  sidebar: { label: display, icon: 'package', order: 100 },
  permissions: ['reader.events.subscribe', 'storage'],
  lucide_icons: ['package'],
}, null, 2);

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>%DISPLAY%</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, sans-serif; padding: 24px;
           background: #faf7f2; color: #3d3529; }
    h1 { font-size: 1.3rem; margin-bottom: 8px; }
    p { font-size: 0.85rem; color: #8b806e; }
    .status { margin-top: 16px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>%DISPLAY%</h1>
  <p>Moke extension — edit ui/index.html to get started.</p>
  <div class="status">UI ready. Add a backend for host API access.</div>
</body>
</html>`;

const README = `# %DISPLAY%

A Moke extension.

## Development

1. Start Moke in dev mode: \`pnpm tauri dev\`
2. Copy this folder to \`%APPDATA%\\com.moke.client\\extensions\\%NAME%\\\`
3. In Moke, go to Settings > Extensions > Enable "%DISPLAY%"
4. Open a book and see your extension in the sidebar

## Build

\`\`\`bash
moke-ext build
moke-ext sign --key ../publisher.pem --key-id local-dev
moke-ext package   # import the ZIP in Moke
\`\`\`
`;

export default function init(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: moke-ext init <extension-name>');
    console.error('  Extension name: lowercase letters, digits, hyphens only (e.g. my-extension)');
    process.exit(1);
  }

  // Validate name
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
    console.error('Invalid extension name. Must be: lowercase letters, digits, hyphens only.');
    console.error('Must start with a letter, must not end with a hyphen.');
    console.error('Examples: reading-stats, my-extension, book-export-v2');
    process.exit(1);
  }

  const display = name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  if (existsSync(name)) {
    console.error(`Directory "${name}" already exists.`);
    process.exit(1);
  }

  // Create directories
  mkdirSync(join(name, 'ui'), { recursive: true });

  // Write files
  writeFileSync(join(name, 'manifest.json'), MANIFEST_TEMPLATE(name, display) + '\n');
  writeFileSync(join(name, 'ui', 'index.html'), INDEX_HTML.replace(/%NAME%/g, name).replace(/%DISPLAY%/g, display));
  writeFileSync(join(name, 'README.md'), README.replace(/%NAME%/g, name).replace(/%DISPLAY%/g, display));

  console.log(`Extension "${name}" created successfully!`);
  console.log();
  console.log(`  cd ${name}`);
  console.log(`  moke-ext validate     Check manifest`);
  console.log(`  moke-ext build        Build for distribution`);
  console.log();
  console.log('Next steps:');
  console.log(`  1. Edit ${name}/manifest.json — set author, description, permissions`);
  console.log(`  2. Edit ${name}/ui/index.html — build your UI`);
  console.log(`  3. Copy to %APPDATA%\\com.moke.client\\extensions\\${name}\\`);
  console.log(`  4. Enable in Moke > Settings > Extensions`);
}
