import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const root = path.resolve(process.argv[2] || 'out');
const port = Number(process.env.MOKE_TAURI_PREVIEW_PORT || 31391);
const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.epub': 'application/epub+zip' };

// Next static exports use route.html while native navigation keeps /route.
// Exported .txt payloads are RSC responses; an unknown content type makes the
// router fall back to replacing the document and loses the runtime connection.
// Serve only the export root, without proxying any API or native operation.
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error('outside export root');
    for (const candidate of [file, file + '.html', path.join(file, 'index.html')]) {
      const info = await stat(candidate).catch(() => null);
      if (!info?.isFile()) continue;
      response.writeHead(200, { 'content-type': mime[path.extname(candidate)] || 'application/octet-stream' });
      response.end(await readFile(candidate));
      return;
    }
    response.writeHead(404); response.end('Not found');
  } catch {
    response.writeHead(400); response.end('Invalid request');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Tauri frontend preview ready on http://127.0.0.1:${port}`));
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
