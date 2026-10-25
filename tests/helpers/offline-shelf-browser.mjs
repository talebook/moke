import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Run the real storage implementation against the browser's IndexedDB. Only
// native IPC and diagnostics/network are replaced; there is no fake IDB.
export async function installOfflineShelfModule(page) {
  const modules = new Map(['offline-books', 'offline-book-core', 'sample-book-info', 'sample-book-coordination'].map(name => {
    const source = readFileSync(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8')
      .replaceAll('process.env.NEXT_PUBLIC_APP_PLATFORM', "'tauri'")
      .replaceAll("'@tauri-apps/api/core'", "'./tauri-core.js'")
      .replaceAll("'@/lib/api'", "'./api.js'");
    return [`${name}.ts`, ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText];
  }));
  modules.set('debug-log.ts', 'export const debugLog = () => {};');
  modules.set('tauri-core.js', 'export const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args);');
  modules.set('api.js', 'export const request = async () => new Response("{\\"err\\":\\"ok\\"}");');
  await page.route('**/__offline-test/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (!name) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline storage regression</title>' });
    const body = modules.get(name);
    return route.fulfill({ status: body ? 200 : 404, contentType: 'text/javascript', body: body || 'Unknown test module' });
  });
}
