import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteOfflineBook,
  getOfflineBook,
  saveOfflineBook,
  saveOfflineBookStream,
  shouldPreserveOfflinePartial,
} from '../src/lib/offline-books.ts';
import {
  beginOfflineDownload,
  classifyOfflineRangeResponse,
  endOfflineDownload,
  hasEpubCentralDirectory,
  makeOfflineBookKey,
  makeOfflineRelativePath,
  parseContentRange,
  sanitizeOfflineFileName,
  shouldResumeOfflineDownload,
} from '../src/lib/offline-book-core.ts';

test('EPUB requires a ZIP central directory at the end of the file', async () => {
  const validEpub = new Blob([
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const truncatedEpub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])]);

  assert.equal(await hasEpubCentralDirectory(validEpub), true);
  assert.equal(await hasEpubCentralDirectory(truncatedEpub), false);
});

test('EPUB 允许 EOCD 之后存在少量尾部字节', async () => {
  const eocd = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const trailing = new Blob([
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    eocd,
    new Uint8Array([0x0a, 0x0d, 0x0a]),
  ]);
  assert.equal(await hasEpubCentralDirectory(trailing), true);

  const excessive = new Blob([
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    eocd,
    new Uint8Array(5000),
  ]);
  assert.equal(await hasEpubCentralDirectory(excessive), false);
});

function makeAsyncRequest(operation) {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };

  queueMicrotask(() => {
    try {
      request.result = operation();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });

  return request;
}

function createFakeIndexedDb() {
  const records = new Map();
  let storeCreated = false;

  const objectStore = {
    get(key) {
      return makeAsyncRequest(() => records.get(key));
    },
    getAll() {
      return makeAsyncRequest(() => [...records.values()]);
    },
    put(record) {
      return makeAsyncRequest(() => {
        records.set(record.id, record);
        return record.id;
      });
    },
    getAll() {
      return makeAsyncRequest(() => Array.from(records.values()));
    },
    delete(key) {
      return makeAsyncRequest(() => records.delete(key));
    },
  };

  const database = {
    objectStoreNames: {
      contains() {
        return storeCreated;
      },
    },
    createObjectStore() {
      storeCreated = true;
      return objectStore;
    },
    transaction() {
      return { objectStore: () => objectStore };
    },
  };

  return {
    records,
    open() {
      const request = {
        result: database,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        if (!storeCreated) request.onupgradeneeded?.();
        request.onsuccess?.();
      });

      return request;
    },
  };
}

function installWebOfflineStore() {
  const indexedDB = createFakeIndexedDb();
  globalThis.window = { indexedDB };
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  return indexedDB;
}

function installTauriOfflineStore(appDataDir = '/data/user/0/org.houheya.moke') {
  const indexedDB = createFakeIndexedDb();
  const calls = [];
  const recordedBooks = [];
  let nextResourceId = 1;
  const validEpubBytes = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04,
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const normalizePath = (parts) => {
    const joined = parts.join('/').replaceAll(/\/{2,}/g, '/');
    return parts[0].startsWith('/') ? `/${joined.replace(/^\/+/, '')}` : joined;
  };

  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  globalThis.window = {
    indexedDB,
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'moke_list_downloaded_books') return [];
        if (command === 'moke_record_downloaded_book') {
          recordedBooks.push(args.book);
          return null;
        }
        if (command === 'plugin:path|resolve_directory') return appDataDir;
        if (command === 'plugin:path|join') return normalizePath(args.paths);
        if (command === 'plugin:path|dirname') return args.path.slice(0, args.path.lastIndexOf('/'));
        if (command === 'plugin:fs|open') return nextResourceId++;
        if (command === 'plugin:fs|write') return args.data.length;
        if (command === 'plugin:fs|stat') return {
          isFile: true,
          isDirectory: false,
          isSymlink: false,
          size: validEpubBytes.length,
          mtime: null,
          atime: null,
          birthtime: null,
          readonly: false,
          fileAttributes: null,
        };
        if (command === 'plugin:fs|seek') return 0;
        if (command === 'plugin:fs|read') {
          const response = new Uint8Array(validEpubBytes.length + 8);
          response.set(validEpubBytes);
          response[response.length - 1] = validEpubBytes.length;
          return response;
        }
        if (command === 'plugin:fs|exists') return false;
        if (command === 'plugin:fs|mkdir'
          || command === 'plugin:fs|ftruncate'
          || command === 'plugin:fs|rename'
          || command === 'plugin:fs|remove'
          || command === 'plugin:resources|close') return null;
        throw new Error(`Unexpected Tauri command: ${command}`);
      },
    },
  };
  return { calls, indexedDB, recordedBooks };
}

test('离线书籍键会隔离服务器、书籍和格式', () => {
  assert.equal(makeOfflineBookKey('https://a.example', '12'), 'https://a.example::12');
  assert.equal(makeOfflineBookKey('https://a.example', '12', 'EPUB'), 'https://a.example::12::epub');
  assert.notEqual(makeOfflineBookKey('https://a.example', '12', 'epub'), makeOfflineBookKey('https://a.example', '12', 'pdf'));
  assert.notEqual(makeOfflineBookKey('https://a.example', '12'), makeOfflineBookKey('https://b.example', '12'));

  const path = makeOfflineRelativePath('https://a.example:8080', '../12', 'EPUB', '三体:全集?.epub');
  assert.match(path, /^books\/a\.example_8080-[0-9a-f]{8}\/_12\/epub\/三体_全集_\.epub$/);
  assert.equal(path.includes('..'), false);
});

test('Range 响应只接受合法 Content-Range', () => {
  assert.deepEqual(parseContentRange('bytes 100-199/300'), { start: 100, end: 199, total: 300 });
  assert.deepEqual(parseContentRange('bytes 100-199/*'), { start: 100, end: 199, total: null });
  assert.equal(parseContentRange('bytes 200-100/300'), null);
  assert.equal(parseContentRange(null), null);
  assert.equal(classifyOfflineRangeResponse(100, 206, parseContentRange('bytes 100-199/300')), 'resume');
  assert.equal(classifyOfflineRangeResponse(100, 200, null), 'restart');
  assert.equal(classifyOfflineRangeResponse(100, 416, null), 'retry-full');
  assert.equal(classifyOfflineRangeResponse(100, 500, null), 'restart');
  assert.equal(classifyOfflineRangeResponse(100, 206, null), 'retry-full');
  assert.equal(classifyOfflineRangeResponse(0, 206, null), 'invalid');
  assert.equal(classifyOfflineRangeResponse(0, 206, parseContentRange('bytes 0-299/300')), 'full');
});

test('瞬时下载失败保留断点，校验和存储失败清理断点', () => {
  assert.equal(shouldPreserveOfflinePartial(new TypeError('network interrupted'), true), true);
  assert.equal(shouldPreserveOfflinePartial(new Error('book.download.incomplete'), true), true);
  assert.equal(shouldPreserveOfflinePartial(new Error('book.download.transfer_failed'), true), true);
  assert.equal(shouldPreserveOfflinePartial(new Error('http.503'), true), true);
  assert.equal(shouldPreserveOfflinePartial(new DOMException('paused', 'AbortError'), true), true);
  assert.equal(shouldPreserveOfflinePartial(new Error('book.epub.invalid'), true), false);
  assert.equal(shouldPreserveOfflinePartial(new Error('book.download.storage_failed'), true), false);
  assert.equal(shouldPreserveOfflinePartial(new Error('book.download.incomplete'), false), false);
});

test('Web 重试从零开始，Tauri 只续传未完成任务', () => {
  assert.equal(shouldResumeOfflineDownload('web', 'failed'), false);
  assert.equal(shouldResumeOfflineDownload('web', 'paused'), false);
  assert.equal(shouldResumeOfflineDownload('tauri', 'failed'), true);
  assert.equal(shouldResumeOfflineDownload('tauri', 'paused'), true);
  assert.equal(shouldResumeOfflineDownload('tauri', 'completed'), false);
});

test('离线文件名会清理系统不允许的字符', () => {
  assert.equal(sanitizeOfflineFileName('三体:全集?.epub.'), '三体_全集_.epub');
  assert.equal(sanitizeOfflineFileName('...'), 'book.epub');
});

test('离线文件名会规避 Windows 保留名并截断超长名称', () => {
  assert.equal(sanitizeOfflineFileName('CON.epub'), '_CON.epub');
  assert.equal(sanitizeOfflineFileName('nul.pdf'), '_nul.pdf');
  assert.equal(sanitizeOfflineFileName('LPT1.txt'), '_LPT1.txt');
  assert.equal(sanitizeOfflineFileName('aux'), '_aux');

  const longName = sanitizeOfflineFileName(`${'书'.repeat(300)}.epub`);
  assert.ok(longName.length <= 120);
  assert.ok(longName.endsWith('.epub'));
});

test('下载在途去重按 服务器+书 维度生效', () => {
  assert.equal(beginOfflineDownload('https://a.example', '1'), true);
  assert.equal(beginOfflineDownload('https://a.example', '1'), false);
  assert.equal(beginOfflineDownload('https://a.example', '2'), true);
  assert.equal(beginOfflineDownload('https://b.example', '1'), true);

  endOfflineDownload('https://a.example', '1');
  assert.equal(beginOfflineDownload('https://a.example', '1'), true);
  endOfflineDownload('https://a.example', '1');
  endOfflineDownload('https://a.example', '2');
  endOfflineDownload('https://b.example', '1');
});

test('网页版可以保存并重新读取离线书籍', async () => {
  installWebOfflineStore();
  const blob = new Blob(['book-data'], { type: 'application/epub+zip' });

  await saveOfflineBook({
    serverUrl: 'https://a.example',
    bookId: '42',
    title: '测试书籍',
    author: '测试作者',
    inShelf: true,
    fileName: '测试:书籍?.epub',
    mimeType: 'application/epub+zip',
    blob,
  });

  const record = await getOfflineBook('https://a.example', '42');
  assert.ok(record);
  assert.equal(record.id, 'https://a.example::42::epub');
  assert.equal(record.fileName, '测试_书籍_.epub');
  assert.equal(record.title, '测试书籍');
  assert.equal(record.author, '测试作者');
  assert.equal(record.inShelf, true);
  assert.equal(await record.blob.text(), 'book-data');
  assert.equal(record.filePath, undefined);
  assert.equal(typeof record.updatedAt, 'number');
});

test('同一本书多个格式可以并存且互不覆盖', async () => {
  const indexedDB = installWebOfflineStore();
  for (const format of ['epub', 'pdf']) {
    await saveOfflineBook({
      serverUrl: 'https://a.example', bookId: '8', title: '多格式', format,
      fileName: `多格式.${format}`, mimeType: 'application/octet-stream', blob: new Blob([format]),
    });
  }
  assert.equal(indexedDB.records.size, 2);
  assert.equal(await (await getOfflineBook('https://a.example', '8', 'epub')).blob.text(), 'epub');
  assert.equal(await (await getOfflineBook('https://a.example', '8', 'pdf')).blob.text(), 'pdf');
});

test('重复保存会更新原记录，多个服务器之间互不覆盖', async () => {
  const indexedDB = installWebOfflineStore();

  const save = (serverUrl, title) => saveOfflineBook({
    serverUrl,
    bookId: '7',
    title,
    fileName: `${title}.epub`,
    mimeType: 'application/epub+zip',
    blob: new Blob([title]),
  });

  await save('https://a.example', '旧标题');
  await save('https://a.example', '新标题');
  await save('https://b.example', '另一服务器');

  assert.equal(indexedDB.records.size, 2);
  assert.equal((await getOfflineBook('https://a.example', '7'))?.title, '新标题');
  assert.equal((await getOfflineBook('https://b.example', '7'))?.title, '另一服务器');
});

test('删除只移除目标离线书籍，删除不存在的记录也不会失败', async () => {
  installWebOfflineStore();

  for (const bookId of ['1', '2']) {
    await saveOfflineBook({
      serverUrl: 'https://a.example',
      bookId,
      title: `书籍 ${bookId}`,
      fileName: `${bookId}.epub`,
      mimeType: 'application/epub+zip',
      blob: new Blob([bookId]),
    });
  }

  await deleteOfflineBook('https://a.example', '1');
  await deleteOfflineBook('https://a.example', 'missing');

  assert.equal(await getOfflineBook('https://a.example', '1'), null);
  assert.equal((await getOfflineBook('https://a.example', '2'))?.bookId, '2');
});

test('桌面版 IndexedDB 记录丢失后会从原生磁盘索引恢复已下载状态', async () => {
  const indexedDB = createFakeIndexedDb();
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  globalThis.window = {
    indexedDB,
    __TAURI_INTERNALS__: {
      invoke: async (command) => {
        assert.equal(command, 'moke_list_downloaded_books');
        return [{
          id: 'https://a.example::42',
          serverUrl: 'https://a.example:443',
          bookId: '42',
          title: '西游记',
          fileName: '西游记.epub',
          mimeType: 'application/epub+zip',
          updatedAt: 123,
          filePath: '/app-data/books/西游记.epub',
        }];
      },
    },
  };

  const recovered = await getOfflineBook('https://a.example', '42');
  assert.equal(recovered?.title, '西游记');
  assert.equal(recovered?.filePath, '/app-data/books/西游记.epub');
  assert.equal(indexedDB.records.get('https://a.example::42')?.title, '西游记');
});

test('Tauri 默认下载目录的所有文件操作都使用 AppData 相对路径', async () => {
  const { calls, indexedDB, recordedBooks } = installTauriOfflineStore();

  await saveOfflineBookStream({
    serverUrl: 'https://books.example.test',
    bookId: '10',
    title: '西游记',
    fileName: '西游记.epub',
    mimeType: 'application/epub+zip',
    format: 'epub',
    write: async (writer) => {
      await writer.write(new Uint8Array([
        0x50, 0x4b, 0x03, 0x04,
        0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]));
      return { size: 26 };
    },
  });

  const pathCalls = calls.filter(({ command }) => [
    'plugin:fs|mkdir',
    'plugin:fs|open',
    'plugin:fs|stat',
    'plugin:fs|exists',
    'plugin:fs|rename',
    'plugin:fs|remove',
  ].includes(command));
  assert.ok(pathCalls.length > 0);
  for (const { command, args } of pathCalls) {
    if (command === 'plugin:fs|rename') {
      assert.match(args.oldPath, /^books\//);
      assert.match(args.newPath, /^books\//);
      assert.deepEqual(args.options, { oldPathBaseDir: 14, newPathBaseDir: 14 });
    } else {
      assert.match(args.path, /^books\//);
      assert.equal(args.options.baseDir, 14);
    }
  }
  assert.equal(recordedBooks.length, 1);
  assert.match(
    indexedDB.records.get('https://books.example.test::10::epub').filePath,
    /^\/data\/user\/0\/org\.houheya\.moke\/books\//,
  );
  assert.match(recordedBooks[0].relativePath, /^books\//);
});

test('Windows 续传使用可截断写句柄并显式定位到断点', async () => {
  const { calls } = installTauriOfflineStore();

  await saveOfflineBookStream({
    serverUrl: 'https://books.example.test',
    bookId: '10',
    title: '续传测试',
    fileName: '续传测试.pdf',
    mimeType: 'application/pdf',
    format: 'pdf',
    resume: true,
    write: async (writer) => {
      assert.equal(writer.position, 26);
      await writer.truncate();
      assert.equal(writer.position, 0);
      await writer.write(new Uint8Array([1]));
      return { size: 1 };
    },
  });

  const openCall = calls.find(({ command }) => command === 'plugin:fs|open');
  assert.equal(openCall.args.options.write, true);
  assert.equal(openCall.args.options.append, undefined);
  assert.equal(openCall.args.options.truncate, false);
  assert.ok(calls.some(({ command, args }) => command === 'plugin:fs|seek' && args.offset === 26));
  assert.ok(calls.some(({ command }) => command === 'plugin:fs|ftruncate'));
});

test('Tauri 自定义下载目录继续使用已授权的绝对路径', async () => {
  const { calls, indexedDB, recordedBooks } = installTauriOfflineStore();

  await saveOfflineBookStream({
    serverUrl: 'https://books.example.test',
    bookId: '10',
    title: '西游记',
    fileName: '西游记.pdf',
    mimeType: 'application/pdf',
    format: 'pdf',
    downloadDirectory: '/storage/emulated/0/Moke',
    write: async (writer) => {
      await writer.write(new Uint8Array([1]));
      return { size: 1 };
    },
  });

  for (const { command, args } of calls.filter(({ command }) => command.startsWith('plugin:fs|'))) {
    if (command === 'plugin:fs|write') continue;
    if (command === 'plugin:fs|rename') {
      assert.match(args.oldPath, /^\/storage\/emulated\/0\/Moke\//);
      assert.match(args.newPath, /^\/storage\/emulated\/0\/Moke\//);
      assert.equal(args.options, undefined);
    } else {
      assert.match(args.path, /^\/storage\/emulated\/0\/Moke\//);
      assert.equal(args.options?.baseDir, undefined);
    }
  }
  assert.equal(recordedBooks[0].storageRoot, '/storage/emulated/0/Moke');
  assert.match(
    indexedDB.records.get('https://books.example.test::10::pdf').filePath,
    /^\/storage\/emulated\/0\/Moke\//,
  );
});

test('兼容已升级到 v2 的 IndexedDB，不用较低版本打开且可识别格式化 key', async () => {
  const indexedDB = createFakeIndexedDb();
  const open = indexedDB.open.bind(indexedDB);
  const requestedVersions = [];
  indexedDB.open = (name, version) => {
    requestedVersions.push(version);
    if (version !== undefined && version < 2) {
      return makeAsyncRequest(() => {
        throw new DOMException('Requested version is lower than existing version', 'VersionError');
      });
    }
    return open(name, version);
  };
  indexedDB.records.set('https://a.example::42::epub', {
    id: 'https://a.example::42::epub',
    serverUrl: 'https://a.example',
    bookId: '42',
    format: 'epub',
    title: '西游记',
    fileName: '西游记.epub',
    mimeType: 'application/epub+zip',
    updatedAt: 123,
  });
  globalThis.window = { indexedDB };
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';

  const record = await getOfflineBook('https://a.example', '42');
  assert.equal(record?.id, 'https://a.example::42::epub');
  assert.deepEqual(requestedVersions, [undefined]);
});

test('桌面版以磁盘索引校验 IndexedDB，文件已不存在时不误显示阅读按钮', async () => {
  const indexedDB = createFakeIndexedDb();
  indexedDB.records.set('https://a.example::42', {
    id: 'https://a.example::42',
    serverUrl: 'https://a.example',
    bookId: '42',
    title: '西游记',
    fileName: '西游记.epub',
    mimeType: 'application/epub+zip',
    updatedAt: 123,
    filePath: '/app-data/books/西游记.epub',
  });
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  globalThis.window = {
    indexedDB,
    __TAURI_INTERNALS__: {
      invoke: async () => [],
    },
  };

  assert.equal(await getOfflineBook('https://a.example', '42'), null);
});
