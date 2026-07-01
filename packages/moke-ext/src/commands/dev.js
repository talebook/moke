// moke-ext dev — development server for extension

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';

export default function dev(args) {
  const cwd = process.cwd();

  // Parse port
  let port = 19557;
  const portIdx = args.indexOf('--port');
  if (portIdx >= 0 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || port;
  }

  // Determine UI directory
  let uiDir = join(cwd, 'ui');
  if (!existsSync(uiDir)) {
    console.error('ui/ directory not found. Make sure you are in an extension project root.');
    process.exit(1);
  }

  const mime = (p) => {
    const ext = p.split('.').pop();
    const map = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
    };
    return map[ext] || 'application/octet-stream';
  };

  const server = createServer(async (req, res) => {
    let url = req.url === '/' ? '/index.html' : req.url;
    // Prevent path traversal
    if (url.includes('..')) { res.writeHead(403); res.end(); return; }

    const filePath = join(uiDir, url);

    // /api/token — return simulated token for dev
    if (req.url === '/api/token') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ token: 'dev-token-use-real-token-in-production' }));
      return;
    }

    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': mime(url), 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('404');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const manifestPath = join(cwd, 'manifest.json');
    const name = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf-8')).name
      : 'extension';

    console.log(`Moke extension dev server`);
    console.log(`  Extension: ${name}`);
    console.log(`  URL:       http://127.0.0.1:${port}`);
    console.log(`  Token:     dev-token-use-real-token-in-production`);
    console.log();
    console.log('To test in Moke:');
    console.log(`  1. Copy this folder to %APPDATA%\\com.moke.client\\extensions\\${name}\\`);
    console.log('  2. Enable in Moke > Settings > Extensions');
    console.log('  3. Click sidebar item to view');
    console.log();
    console.log('Press Ctrl+C to stop.');
  });
}
