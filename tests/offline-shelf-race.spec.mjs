import { test, expect } from '@playwright/test';
import { installOfflineShelfModule } from './helpers/offline-shelf-browser.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

for (const committedBeforeReply of [false, true]) {
  test(`real IDB: shelf/deletion race (native committed before reply: ${committedBeforeReply})`, async ({ page }) => {
    await installOfflineShelfModule(page);
    await page.goto(`${APP_URL}/__offline-test/`);
    const result = await page.evaluate(async committedBeforeReply => {
      const api = await import('/__offline-test/offline-books.ts');
      const book = { id: 'https://books.test::8::pdf', serverUrl: 'https://books.test', bookId: '8',
        title: '虚构漫画', fileName: 'comic.pdf', filePath: '/test-data/comic.pdf', updatedAt: 123, inShelf: true };
      let native = [book];
      let enter;
      let release;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === 'moke_list_downloaded_books') return structuredClone(native);
        if (command === 'moke_delete_downloaded_book_file') return;
        if (command === 'moke_remove_downloaded_book') { native = native.filter(row => row.id !== args.id); return; }
        if (command === 'moke_record_downloaded_book') {
          const commit = () => { native = [structuredClone(args.book)]; };
          if (committedBeforeReply) commit();
          enter();
          await gate;
          if (!committedBeforeReply) commit();
          return;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      } };
      await api.listOfflineBooks(); // Recover a missing IDB row first.
      await api.cacheOfflineMediaType(book.serverUrl, book.bookId, 'comic');
      const updating = api.setOfflineBookShelfState(book.serverUrl, book.bookId, false);
      await entered;
      const deleting = api.deleteOfflineBook('https://books.test:443', book.bookId, 'pdf');
      // Yield across real IDB transaction tasks while the IPC is suspended.
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      await Promise.all([updating, deleting]);
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
      return { nativeIds: native.map(row => row.id), downloadedIds: rows.filter(row => 'bookId' in row).map(row => row.id),
        classification: rows.find(row => row.id.startsWith('media-type::'))?.media_type };
    }, committedBeforeReply);
    expect(result).toEqual({ nativeIds: [], downloadedIds: [], classification: 'comic' });
  });
}
