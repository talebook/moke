import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

for (const runtime of ['android', 'ohos']) {
  test(`a cached invalid book keeps an exit and returns to Moke on ${runtime}`, async ({ page }) => {
    await installLibraryLayoutMock(page, { nativeRuntime: runtime });
    await page.route('http://rangefile.localhost/**', route => route.abort());
    await page.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      const content = new TextEncoder().encode('{"err":"user.need_login","msg":"Please sign in"}'.padEnd(100));
      const handles = new Map();
      let nextId = 2000;
      window.__READER_TEST_CALLS = [];
      window.__TAURI_OS_PLUGIN_INTERNALS__ = {
        platform: 'android', osType: 'android', arch: 'aarch64', version: '15',
        family: 'unix', eol: '\n', locale: 'en-US',
      };
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        window.__READER_TEST_CALLS.push(command);
        if (command === 'get_executable_dir') return '/app';
        if (command === 'plugin:path|resolve_directory') return '/data/app';
        if (command === 'plugin:path|join') return args.paths.join('/').replace(/\/+/g, '/');
        if (command === 'plugin:path|basename') return args.path.split('/').pop();
        if (command === 'plugin:path|dirname') return args.path.slice(0, args.path.lastIndexOf('/'));
        if (command === 'plugin:fs|exists') return args.path === '/books/bad.azw3';
        if (command === 'plugin:fs|read_dir') return [];
        if (command === 'plugin:fs|read_text_file') return '{}';
        if (command === 'plugin:fs|open') {
          const id = nextId++;
          handles.set(id, { position: 0 });
          return id;
        }
        if (command === 'plugin:fs|fstat' || command === 'plugin:fs|stat') {
          return { size: content.length, isFile: true, isDirectory: false,
            isSymlink: false, mtime: null, atime: null, birthtime: null };
        }
        if (command === 'plugin:fs|seek') {
          const handle = handles.get(args.rid);
          handle.position = args.offset;
          return handle.position;
        }
        if (command === 'plugin:fs|read') {
          const handle = handles.get(args.rid);
          const bytes = content.slice(handle.position, handle.position + args.len);
          handle.position += bytes.length;
          const response = new Uint8Array(bytes.length + 8);
          response.set(bytes);
          new DataView(response.buffer).setBigUint64(bytes.length, BigInt(bytes.length));
          return response.buffer;
        }
        if (command === 'parse_mobi_metadata') throw new Error('parse mobi: expected type header identifier BOOK or TEXT');
        if (command === 'plugin:native-bridge|has_ambient_light_sensor') return { available: false };
        if (command === 'plugin:native-bridge|get_screen_brightness') return { brightness: 1 };
        if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0, right: 0, bottom: 0, left: 0 };
        if (command === 'moke_navigate') {
          if (args.path !== '/library') throw new Error('Invalid Reader return target');
          localStorage.setItem('reader-recovery-target', args.path);
          window.location.assign(args.path);
          return null;
        }
        return original(command, args);
      };
    });
    const params = new URLSearchParams({ moke: '1', mokeReturnTo: '/library',
      mokeRuntimePlatform: runtime, file: '/books/bad.azw3' });
    await page.goto(`${APP_URL}/readest/reader?${params}`);
    await expect(page.getByRole('heading', { name: /Unable to open book|无法打开书籍/ })).toBeVisible({ timeout: 30_000 });
    // The transient toast expires, while the recovery control must remain.
    await expect(page.locator('.toast')).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Go Back|返回/ })).toBeVisible();
    await page.getByRole('button', { name: /Go Back|返回/ }).click();
    await expect(page).toHaveURL(/\/library(?:\?.*)?$/);
    expect(await page.evaluate(() => localStorage.getItem('reader-recovery-target'))).toBe('/library');
  });
}
