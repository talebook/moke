import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Run the real storage implementation against the browser's IndexedDB. Only
// native IPC and diagnostics/network are replaced; there is no fake IDB.
export async function installOfflineShelfModule(page) {
  const modules = new Map(['offline-books', 'offline-book-core', 'api-core', 'sample-book-info', 'sample-book-coordination'].map(name => {
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

export async function exerciseDelayedOfflineRecovery(page, options) {
  return page.evaluate(async ({ path, mutation, pendingDeletion = false }) => {
    const api = await import('/__offline-test/offline-books.ts');
    const book = { id: 'https://books.test::8::pdf', serverUrl: 'https://books.test', bookId: '8',
      title: '虚构漫画', fileName: 'comic.pdf', filePath: '/test-data/comic.pdf', updatedAt: 123, inShelf: true };
    const other = { ...book, id: 'https://other.test::8::pdf', serverUrl: 'https://other.test' };
    let native = [book];
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const captured = deferred();
    const releaseSnapshot = deferred();
    const deletingFile = deferred();
    const releaseFile = deferred();
    const removed = deferred();
    const releaseRemoval = deferred();
    let delayNextSnapshot = false;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'moke_list_downloaded_books') {
        const snapshot = structuredClone(native);
        if (delayNextSnapshot) {
          delayNextSnapshot = false;
          captured.resolve();
          await releaseSnapshot.promise;
        }
        return snapshot;
      }
      if (command === 'moke_delete_downloaded_book_file') {
        if (pendingDeletion) {
          deletingFile.resolve();
          await releaseFile.promise;
        }
        return;
      }
      if (command === 'moke_remove_downloaded_book') {
        native = native.filter(row => row.id !== args.id);
        if (pendingDeletion) {
          removed.resolve();
          await releaseRemoval.promise;
        }
        return;
      }
      if (command === 'moke_record_downloaded_book') {
        native = native.map(row => row.id === args.book.id ? { ...row, ...structuredClone(args.book) } : row);
        return;
      }
      throw new Error(`Unexpected IPC: ${command}`);
    } };
    await api.listOfflineBooks();
    await api.cacheOfflineMediaType(book.serverUrl, book.bookId, 'comic');
    // This native-only row must remain recoverable while another server's
    // matching book ID is being modified.
    native.push(other);
    const mutate = () => mutation === 'delete'
      ? api.deleteOfflineBook('https://books.test:443', book.bookId, 'pdf')
      : api.setOfflineBookShelfState('https://books.test:443', book.bookId, false);
    let changing;
    if (pendingDeletion) {
      changing = mutate();
      await deletingFile.promise;
    }
    delayNextSnapshot = true;
    const recovering = path === 'get'
      ? api.getOfflineBook(book.serverUrl, book.bookId, 'pdf')
      : api.listOfflineBooks(book.serverUrl).then(rows => rows.find(row => row.id === book.id) ?? null);
    await captured.promise;
    if (pendingDeletion) {
      releaseFile.resolve();
      await removed.promise; // Both indexes are deleted; the IPC reply is held.
    } else await mutate();
    releaseSnapshot.resolve();
    const recovered = await recovering;
    const recoveredOther = await api.getOfflineBook(other.serverUrl, other.bookId, 'pdf');
    // Inspect real IDB before releasing a pending deletion's reply.
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('moke-offline-books');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const read = db.transaction('books').objectStore('books').getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    db.close();
    if (pendingDeletion) {
      releaseRemoval.resolve();
      await changing;
    }
    const target = rows.find(row => row.id === book.id);
    return { returned: recovered ? { inShelf: recovered.inShelf } : null,
      indexed: target ? { inShelf: target.inShelf } : null,
      native: native.find(row => row.id === book.id) ? { inShelf: native.find(row => row.id === book.id).inShelf } : null,
      recoveredOther: recoveredOther?.id,
      classification: rows.find(row => row.id.startsWith('media-type::'))?.media_type };
  }, options);
}
