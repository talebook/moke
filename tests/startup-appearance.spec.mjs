import { test, expect as baseExpect } from '@playwright/test';
import { installLibraryLayoutMock, LAYOUT_BOOK, LAYOUT_OFFLINE_BOOK } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

// Run against pnpm dev-preview. Native licensing/window/book calls are mocked;
// this measures frontend frames, not OS-level window composition or real Reader.
// Cold dev-server compilation plus bootstrap/main/detail document loads can
// exceed the default five-second assertion timeout on the test host.
const expect = baseExpect.configure({ timeout: 15_000 });

async function expectColdServerList(page) {
  await expect(page).toHaveURL(/\/welcome(?:\?|$)/);
  await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
  const trace = await page.evaluate(() => ({
    opens: sessionStorage.getItem('layout-reader-opens'),
    detailOpens: sessionStorage.getItem('layout-detail-opens'),
    requests: Number(sessionStorage.getItem('startup-http-requests') || 0),
  }));
  expect(trace.opens).toBeNull();
  expect(trace.detailOpens).toBeNull();
  expect(trace.requests).toBe(0);
}

async function installStartupRequestTrace(page) {
  await page.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'plugin:http|fetch') {
        sessionStorage.setItem('startup-http-requests', String(Number(sessionStorage.getItem('startup-http-requests') || 0) + 1));
      }
      return invoke(command, args);
    };
  });
}

async function continueOfflineReading(page) {
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible();
  await page.getByRole('link', { name: `继续阅读《${LAYOUT_BOOK.title}》`, exact: true }).click();
}

for (const appearance of ['light', 'dark', 'eink']) {
  test(`authorized Preview ${appearance} startup waits at the server list before explicit reading`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installLibraryLayoutMock(page, {
      offlineMode: true, startup: true, nativeRuntime: 'android', nativeNavigation: true,
      nativeBooks: [LAYOUT_OFFLINE_BOOK], previewDelayMs: 250, bookLoadDelayMs: 250,
      readerHandoffDelayMs: 250, windowLabel: 'preview-bootstrap', bootstrapHandoff: true,
      theme: appearance === 'dark' ? 'dark' : 'light', eink: appearance === 'eink',
    });
    await installStartupRequestTrace(page);
    await page.addInitScript((bookTitle) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'moke_preview_enter_app') {
          sessionStorage.setItem('startup-handoff-appearance', args.appearance);
        }
        return invoke(command, args);
      };
      const sample = () => {
        const startup = document.querySelector('[data-testid="app-startup-screen"]');
        if (startup) {
          const spinner = startup.querySelector('[aria-hidden="true"]');
          const box = spinner.getBoundingClientRect();
          // Rotation changes the bounding box; compare its stable center and
          // the element's untransformed size instead.
          const frame = {
            stage: sessionStorage.getItem('startup-trace-stage') || 'cold',
            path: location.pathname, x: box.x + box.width / 2, y: box.y + box.height / 2,
            width: spinner.offsetWidth, height: spinner.offsetHeight,
            count: document.querySelectorAll('[data-testid="app-startup-screen"]').length,
          };
          const frames = JSON.parse(sessionStorage.getItem('startup-frames') || '[]');
          if (!frames.some((old) => JSON.stringify(old) === JSON.stringify(frame))) {
            frames.push(frame);
            sessionStorage.setItem('startup-frames', JSON.stringify(frames));
          }
        }
        const headings = [...document.querySelectorAll('h1')].map((heading) => heading.textContent);
        if (headings.includes(bookTitle) || headings.includes('Moke Preview 授权')) {
          sessionStorage.setItem('startup-intermediate-ui', 'true');
        }
        if (location.pathname.startsWith('/readest/')) return;
        requestAnimationFrame(sample);
      };
      document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(sample), { once: true });
    }, LAYOUT_BOOK.title);
    await page.route('**/readest/reader?**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<!doctype html><h1>模拟阅读器就绪</h1>',
    }));
    await page.goto(`${APP_URL}/`, { waitUntil: 'commit' });
    await expectColdServerList(page);
    const coldTrace = await page.evaluate(() => ({
      entered: sessionStorage.getItem('layout-preview-entered'),
      appearance: sessionStorage.getItem('startup-handoff-appearance'),
      flashed: sessionStorage.getItem('startup-intermediate-ui'),
    }));
    expect(coldTrace.entered).toBe('true');
    expect(coldTrace.appearance).toBe(appearance);
    expect(coldTrace.flashed).toBeNull();
    await page.evaluate(() => sessionStorage.setItem('startup-trace-stage', 'explicit-reading'));
    await continueOfflineReading(page);
    await expect(page.getByRole('heading', { name: '模拟阅读器就绪' })).toBeVisible();
    const trace = await page.evaluate(() => ({
      frames: JSON.parse(sessionStorage.getItem('startup-frames') || '[]'),
      flashed: sessionStorage.getItem('startup-intermediate-ui'),
      entered: sessionStorage.getItem('layout-preview-entered'),
      opens: sessionStorage.getItem('layout-reader-opens'),
      detailOpens: sessionStorage.getItem('layout-detail-opens'),
      appearance: sessionStorage.getItem('startup-handoff-appearance'),
    }));
    expect(trace.entered).toBe('true');
    expect(trace.appearance).toBe(appearance);
    expect(trace.opens).toBe('1');
    // The continue-reading Link navigates within this app document; only the
    // Reader handoff uses native document navigation.
    expect(trace.detailOpens).toBeNull();
    expect(trace.flashed).toBeNull();
    expect(trace.frames.some((frame) => frame.stage === 'cold' && frame.path === '/')).toBe(true);
    expect(trace.frames.some((frame) => frame.stage === 'explicit-reading' && frame.path === '/detail')).toBe(true);
    for (const stage of ['cold', 'explicit-reading']) {
      const frames = trace.frames.filter((frame) => frame.stage === stage);
      for (const frame of frames) {
        expect(frame.x).toBeCloseTo(frames[0].x, 0);
        expect(frame.y).toBeCloseTo(frames[0].y, 0);
        expect(frame.width).toBe(32);
        expect(frame.height).toBe(32);
        expect(frame.count).toBe(1);
      }
    }
  });
}

for (const state of ['inactive', 'error']) {
  test(`Preview ${state} still blocks automatic reading and exposes recovery`, async ({ page }) => {
    await installLibraryLayoutMock(page, { startup: true, previewState: state, previewDelayMs: 100 });
    await page.goto(`${APP_URL}/`, { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Moke Preview 授权' })).toBeVisible();
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBeNull();
    if (state === 'inactive') await expect(page.getByLabel('Preview 访问码', { exact: true })).toBeVisible();
    else await expect(page.getByRole('dialog').getByRole('alert')).toContainText('授权');
  });
}

test('missing offline book only reports an error after explicit offline continuation', async ({ page }) => {
  await installLibraryLayoutMock(page, { startup: true, offlineMode: true, nativeRuntime: 'android', nativeNavigation: true });
  await installStartupRequestTrace(page);
  await page.goto(`${APP_URL}/`, { waitUntil: 'commit' });
  await expectColdServerList(page);
  await continueOfflineReading(page);
  await expect(page.getByText('书籍详情加载失败，请检查服务器连接。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
});

for (const readerFailure of [false, true]) {
  test(`explicit desktop continuation ${readerFailure ? 'failure' : 'handoff'} releases the startup screen`, async ({ page }) => {
    await installLibraryLayoutMock(page, {
      startup: true, offlineMode: true, nativeRuntime: 'linux',
      nativeBooks: [LAYOUT_OFFLINE_BOOK], readerFailure,
    });
    await installStartupRequestTrace(page);
    await page.goto(`${APP_URL}/`, { waitUntil: 'commit' });
    await expectColdServerList(page);
    await continueOfflineReading(page);
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    await expect(page).not.toHaveURL(/continue=1/);
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    await expect(page.getByTestId('offline-read-primary-action')).toHaveText('离线阅读');
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
    if (readerFailure) await expect(page.getByText(/阅读器打开请求尚未确认.*退出并重启应用/)).toBeVisible();
    else {
      // Consuming the URL must also update Next's search params so the native
      // shortcut can request this same book again from the current detail.
      await page.evaluate(() => window.dispatchEvent(new Event('moke:continue-reading-request')));
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('2');
      await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    }
  });
}
