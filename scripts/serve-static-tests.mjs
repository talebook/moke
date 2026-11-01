import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Serve the actual static exports, including Next's extensionless page URLs.
// This helper is only for local/CI browser tests and binds to loopback.
const root = path.resolve(process.argv[2] || 'out');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.txt': 'text/x-component', // Next's exported React Server Component payloads.
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    // A route may have both settings.html and a settings/ directory containing
    // nested routes. Prefer its exported page over a nonexistent index.html.
    for (const candidate of [file, `${file}.html`, path.join(file, 'index.html')]) {
      try {
        if ((await stat(candidate)).isFile()) { file = candidate; break; }
      } catch { /* Try the next static-export convention. */ }
    }
    const contents = await readFile(file);
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Static browser tests: http://127.0.0.1:${port}`);
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
