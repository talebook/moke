import { test, expect as baseExpect } from '@playwright/test';
import { installLibraryLayoutMock, LAYOUT_BOOK, LAYOUT_OFFLINE_BOOK } from './helpers/library-layout.mjs';

// Run against pnpm dev-preview. Native licensing/window/book calls are mocked;
// this measures frontend frames, not OS-level window composition or real Reader.
// Cold dev-server compilation plus bootstrap/main/detail document loads can
// exceed the default five-second assertion timeout on the test host.
const expect = baseExpect.configure({ timeout: 15_000 });

for (const appearance of ['light', 'dark', 'eink']) {
  test(`authorized Preview startup keeps one loading screen in ${appearance}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installLibraryLayoutMock(page, {
      offlineMode: true, startup: true, nativeRuntime: 'android', nativeNavigation: true,
      nativeBooks: [LAYOUT_OFFLINE_BOOK], previewDelayMs: 250, bookLoadDelayMs: 250,
      readerHandoffDelayMs: 250, windowLabel: 'preview-bootstrap', bootstrapHandoff: true,
      theme: appearance === 'dark' ? 'dark' : 'light', eink: appearance === 'eink',
    });
    await page.addInitScript((bookTitle) => {
      const sample = () => {
        const startup = document.querySelector('[data-testid="app-startup-screen"]');
        if (startup) {
          const spinner = startup.querySelector('[aria-hidden="true"]');
          const box = spinner.getBoundingClientRect();
          // Rotation changes the bounding box; compare its stable center and
          // the element's untransformed size instead.
          const frame = { path: location.pathname, x: box.x + box.width / 2, y: box.y + box.height / 2, width: spinner.offsetWidth, height: spinner.offsetHeight };
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
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: '模拟阅读器就绪' })).toBeVisible();
    const trace = await page.evaluate(() => ({
      frames: JSON.parse(sessionStorage.getItem('startup-frames') || '[]'),
      flashed: sessionStorage.getItem('startup-intermediate-ui'),
      entered: sessionStorage.getItem('layout-preview-entered'),
      opens: sessionStorage.getItem('layout-reader-opens'),
      detailOpens: sessionStorage.getItem('layout-detail-opens'),
    }));
    expect(trace.entered).toBe('true');
    expect(trace.opens).toBe('1');
    expect(trace.detailOpens).toBe('1');
    expect(trace.flashed).toBeNull();
    expect(trace.frames.some((frame) => frame.path === '/')).toBe(true);
    expect(trace.frames.some((frame) => frame.path === '/detail')).toBe(true);
    for (const frame of trace.frames) {
      expect(frame.x).toBeCloseTo(trace.frames[0].x, 0);
      expect(frame.y).toBeCloseTo(trace.frames[0].y, 0);
      expect(frame.width).toBe(32);
      expect(frame.height).toBe(32);
    }
  });
}

for (const state of ['inactive', 'error']) {
  test(`Preview ${state} still blocks automatic reading and exposes recovery`, async ({ page }) => {
    await installLibraryLayoutMock(page, { startup: true, previewState: state, previewDelayMs: 100 });
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Moke Preview 授权' })).toBeVisible();
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBeNull();
    if (state === 'inactive') await expect(page.getByLabel('Preview 访问码', { exact: true })).toBeVisible();
    else await expect(page.getByRole('dialog').getByRole('alert')).toContainText('授权');
  });
}

test('missing offline book exits the startup screen with a usable error', async ({ page }) => {
  await installLibraryLayoutMock(page, { startup: true, offlineMode: true, nativeRuntime: 'android', nativeNavigation: true });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'commit' });
  await expect(page.getByText('书籍详情加载失败，请检查服务器连接。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
});

for (const readerFailure of [false, true]) {
  test(`desktop reader ${readerFailure ? 'failure' : 'handoff'} releases the startup screen`, async ({ page }) => {
    await installLibraryLayoutMock(page, {
      startup: true, offlineMode: true, nativeRuntime: 'linux',
      nativeBooks: [LAYOUT_OFFLINE_BOOK], readerFailure,
    });
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    await expect(page).not.toHaveURL(/continue=1/);
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    await expect(page.getByTestId('offline-read-primary-action')).toHaveText('离线阅读');
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
    if (readerFailure) await expect(page.getByText('打开书籍失败。', { exact: true })).toBeVisible();
    else {
      // Consuming the URL must also update Next's search params so the native
      // shortcut can request this same book again from the current detail.
      await page.evaluate(() => window.dispatchEvent(new Event('moke:continue-reading-request')));
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('2');
      await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    }
  });
}
