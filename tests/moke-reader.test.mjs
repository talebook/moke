import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmbeddedReaderHomeUrl,
  buildEmbeddedReaderUrl,
  buildReaderHomeWindowLabel,
  isSingleWebviewRuntime,
  resolveRuntimeCategory,
  runtimeCategoryFromPlatform,
  shouldIncludeServerUrl,
} from '../src/lib/moke-reader.ts';

test('OHOS uses the single-WebView reader flow', () => {
  assert.equal(isSingleWebviewRuntime('ohos'), true);
  assert.equal(isSingleWebviewRuntime('android'), true);
  assert.equal(isSingleWebviewRuntime('ios'), true);
  assert.equal(isSingleWebviewRuntime('linux'), false);
  assert.equal(isSingleWebviewRuntime('windows'), false);
});

test('runtimeCategoryFromPlatform classifies each runtime', () => {
  assert.equal(runtimeCategoryFromPlatform('ohos'), 'mobile');
  assert.equal(runtimeCategoryFromPlatform('android'), 'mobile');
  assert.equal(runtimeCategoryFromPlatform('ios'), 'mobile');
  assert.equal(runtimeCategoryFromPlatform('linux'), 'desktop');
  assert.equal(runtimeCategoryFromPlatform('windows'), 'desktop');
  assert.equal(runtimeCategoryFromPlatform('macos'), 'desktop');
});

test('resolveRuntimeCategory falls back to mobile when the probe is unavailable', async () => {
  const prev = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  try {
    // In a plain Node environment there is no Tauri IPC bridge, so the
    // `moke_runtime_platform` invoke cannot succeed. The resolver must NOT
    // fall back to desktop (which would drive an unregistered updater on
    // mobile builds) — it must resolve to mobile instead.
    assert.equal(await resolveRuntimeCategory(), 'mobile');
  } finally {
    if (prev === undefined) {
      delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    } else {
      process.env.NEXT_PUBLIC_APP_PLATFORM = prev;
    }
  }
});

test('resolveRuntimeCategory resolves desktop outside the tauri platform', async () => {
  const prev = process.env.NEXT_PUBLIC_APP_PLATFORM;
  if (prev !== undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
  try {
    assert.equal(await resolveRuntimeCategory(), 'desktop');
  } finally {
    if (prev !== undefined) process.env.NEXT_PUBLIC_APP_PLATFORM = prev;
  }
});

test('reader-home window label never matches the extension reader-* enumeration', () => {
  // H20-L4: 书库首页窗口不能被扩展当成阅读器窗口寻址。
  const label = buildReaderHomeWindowLabel(1234);
  assert.equal(label, 'moke-home-1234');
  assert.ok(!label.startsWith('reader-'));
  assert.ok(label.startsWith('moke-home-'));
});

test('shouldIncludeServerUrl maps runtime → serverUrl inclusion decision', () => {
  // Web build: reader replaces the host app, must save progress itself.
  assert.equal(shouldIncludeServerUrl(false, 'web'), true);
  assert.equal(shouldIncludeServerUrl(false, 'desktop'), true);

  // Single-WebView runtimes: reader replaces the host app, must save itself.
  assert.equal(shouldIncludeServerUrl(true, 'ohos'), true);
  assert.equal(shouldIncludeServerUrl(true, 'android'), true);
  assert.equal(shouldIncludeServerUrl(true, 'ios'), true);

  // Desktop: main-window ReaderProgressProvider is the single saver.
  assert.equal(shouldIncludeServerUrl(true, 'windows'), false);
  assert.equal(shouldIncludeServerUrl(true, 'linux'), false);
  assert.equal(shouldIncludeServerUrl(true, 'macos'), false);
});

test('buildEmbeddedReaderUrl preserves the mobile reader launch context', () => {
  const url = new URL(
    buildEmbeddedReaderUrl({
      filePath: 'C:\\Users\\reader\\我的书.pdf',
      eink: true,
      mokeBookId: '14',
      serverUrl: 'http://192.168.1.5:8080',
      restoreProgress: {
        schema: 'moke.readest.progress.v1',
        reader: 'readest',
        moke_book_id: '14',
        location: 'page=142',
        updated_at: '2026-07-24T00:00:00.000Z',
      },
    }),
    'https://moke.invalid',
  );

  assert.equal(url.pathname, '/readest/reader');
  assert.equal(url.searchParams.get('file'), 'C:\\Users\\reader\\我的书.pdf');
  assert.equal(url.searchParams.get('moke'), '1');
  assert.equal(url.searchParams.get('mokeEink'), '1');
  assert.equal(url.searchParams.get('mokeBookId'), '14');
  assert.equal(url.searchParams.get('mokeServerUrl'), 'http://192.168.1.5:8080');
  assert.deepEqual(JSON.parse(url.searchParams.get('mokeRestoreProgress')), {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: '14',
    location: 'page=142',
    updated_at: '2026-07-24T00:00:00.000Z',
  });

  // Empty serverUrl must not produce a bare `mokeServerUrl=` param.
  const empty = new URL(
    buildEmbeddedReaderUrl({
      filePath: 'C:\\book.pdf',
      eink: false,
      mokeBookId: '15',
      restoreProgress: null,
      serverUrl: '',
    }),
    'https://moke.invalid',
  );
  assert.equal(empty.searchParams.get('moke'), '1');
  assert.equal(empty.searchParams.get('mokeServerUrl'), null);
});

test('buildEmbeddedReaderHomeUrl carries mokeServerUrl only when non-empty', () => {
  // Reader must save progress itself: a serverUrl is carried verbatim.
  const mobile = new URL(
    buildEmbeddedReaderHomeUrl({
      eink: true,
      serverUrl: 'http://192.168.1.5:8080',
    }),
    'https://moke.invalid',
  );
  assert.equal(mobile.pathname, '/readest/');
  assert.equal(mobile.searchParams.get('moke'), '1');
  assert.equal(mobile.searchParams.get('mokeEink'), '1');
  assert.equal(mobile.searchParams.get('mokeServerUrl'), 'http://192.168.1.5:8080');

  // Desktop: callers omit serverUrl, so no mokeServerUrl is emitted and the
  // main window's ReaderProgressProvider is the single saver (no duplicate
  // write via mokeBridge's direct POST).
  const desktop = new URL(
    buildEmbeddedReaderHomeUrl({
      eink: false,
    }),
    'https://moke.invalid',
  );
  assert.equal(desktop.pathname, '/readest/');
  assert.equal(desktop.searchParams.get('moke'), '1');
  assert.equal(desktop.searchParams.get('mokeEink'), '0');
  assert.equal(desktop.searchParams.get('mokeServerUrl'), null);

  // Empty serverUrl must not produce a bare `mokeServerUrl=` param either.
  const empty = new URL(
    buildEmbeddedReaderHomeUrl({
      eink: false,
      serverUrl: '',
    }),
    'https://moke.invalid',
  );
  assert.equal(empty.pathname, '/readest/');
  assert.equal(empty.searchParams.get('moke'), '1');
  assert.equal(empty.searchParams.get('mokeEink'), '0');
  assert.equal(empty.searchParams.get('mokeServerUrl'), null);
});
