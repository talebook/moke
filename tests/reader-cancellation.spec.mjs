import { test, expect } from '@playwright/test';
import { LAYOUT_BOOK, LAYOUT_SERVER_URL } from './helpers/library-layout.mjs';
import { installReaderCancellationMock, releaseReaderIPC, SECOND_BOOK } from './helpers/reader-cancellation.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const detail = (id = '42', auto = true) => `/detail?id=${id}&source=${encodeURIComponent(LAYOUT_SERVER_URL)}${auto ? '&continue=1' : ''}`;
const calls = (page) => page.evaluate(() => window.readerRace.calls);

for (const entry of ['startup', 'detail']) {
  test(`${entry} BACK invalidates the opener before a slow route transition commits`, async ({ page }) => {
    await installReaderCancellationMock(page, { entry, slowBack: true });
    await page.goto(APP_URL + (entry === 'startup' ? '/' : detail()));
    const key = entry === 'startup' ? 'startup' : '42';
    await page.waitForFunction((key) => window.readerRace.backReady && window.readerRace.openerPending === key, key);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('moke:native-back', { detail: { target: '/shelf' } })));
    // Release while the old component is still mounted, before RSC completes.
    await releaseReaderIPC(page, key);
    expect(await calls(page)).toEqual([]);
    await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
    await page.waitForTimeout(1_600);
    await expect(page).toHaveURL(APP_URL + '/shelf');
    expect(await calls(page)).toEqual([]);
  });
}

test('changing source for the same book id cannot launch the previous source record', async ({ page }) => {
  await installReaderCancellationMock(page);
  await page.goto(APP_URL + detail());
  await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
  await page.evaluate(() => window.history.pushState(null, '', '/detail?id=42&source=https%3A%2F%2Fother.books.test&continue=1'));
  await expect(page.getByText('书籍详情加载失败，请检查服务器连接。', { exact: true })).toBeVisible();
  await releaseReaderIPC(page, '42');
  expect(await calls(page)).toEqual([]);
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
});

for (const runtime of ['ios', 'linux']) {
  test(`cancelled ${runtime} detail never opens a document or desktop window`, async ({ page }) => {
    await installReaderCancellationMock(page, { runtime });
    await page.goto(APP_URL + detail());
    await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('moke:native-back', { detail: { target: '/shelf' } })));
    await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
    await releaseReaderIPC(page, '42');
    expect(await calls(page)).toEqual([]);
    await expect(page).toHaveURL(APP_URL + '/shelf');
  });
}

test('pagehide invalidates preparation and pageshow leaves a usable detail for manual reopen', async ({ page }) => {
  await installReaderCancellationMock(page, { runtime: 'linux' });
  await page.goto(APP_URL + detail());
  await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await releaseReaderIPC(page, '42');
  expect(await calls(page)).toEqual([]);
  await expect(page.getByTestId('offline-read-primary-action')).toHaveText('离线阅读');
  await page.getByTestId('offline-read-primary-action').click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
});

for (const fail of [false, true]) {
  for (const target of ['/shelf', '/settings']) {
    test(`startup cancelled by route unmount to ${target} suppresses ${fail ? 'failed' : 'successful'} IPC and fallback`, async ({ page }) => {
      await installReaderCancellationMock(page, { entry: 'startup' });
      await page.goto(APP_URL);
      await page.waitForFunction(() => window.readerRace.backReady && window.readerRace.openerPending === 'startup');
      await page.evaluate((target) => window.dispatchEvent(new CustomEvent('moke:native-back', { detail: { target } })), target);
      await expect(page).toHaveURL(APP_URL + target);
      await releaseReaderIPC(page, 'startup', fail);
      await page.waitForTimeout(1_600);
      expect(await calls(page)).toEqual([]);
      await expect(page).toHaveURL(APP_URL + target);
    });
  }

  test(`BACK while detail prepares suppresses ${fail ? 'failed' : 'successful'} IPC, Reader and fallback`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installReaderCancellationMock(page);
    await page.goto(APP_URL + '/shelf');
    await page.getByRole('link', { name: `继续阅读《${LAYOUT_BOOK.title}》` }).click();
    await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
    await expect(page).not.toHaveURL(/continue=1/);
    await expect(page.getByTestId('app-startup-screen')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('moke:native-back')));
    await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
    await releaseReaderIPC(page, '42', fail);
    expect(await calls(page)).toEqual([]);
    await expect(page).toHaveURL(APP_URL + '/shelf');
  });

  test(`switching books keeps the new opener active after old ${fail ? 'failure' : 'success'}`, async ({ page }) => {
    await installReaderCancellationMock(page);
    await page.goto(APP_URL + detail());
    await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
    // Next synchronizes search params on pushState, reusing DetailContent.
    await page.evaluate((href) => window.history.pushState(null, '', href), detail('43'));
    await page.waitForFunction(() => window.readerRace.pending.includes('43'));
    await releaseReaderIPC(page, '42', fail);
    expect(await calls(page)).toEqual([]);
    await expect(page.getByTestId('app-startup-screen')).toBeVisible();
    await releaseReaderIPC(page, '43');
    const opened = await calls(page);
    expect(opened).toHaveLength(1);
    expect(opened[0].args.path).toContain('mokeBookId=43');
    expect(opened[0].args.path).toContain(encodeURIComponent(SECOND_BOOK.filePath));
  });
}

for (const entry of ['startup', 'detail']) {
  test(`${entry} cancelled during native navigation failure never falls back to the old route`, async ({ page }) => {
    await installReaderCancellationMock(page, { entry, delay: 'navigation' });
    await page.goto(APP_URL + (entry === 'startup' ? '/' : detail()));
    const key = entry === 'startup' ? 'startup' : '42';
    await page.waitForFunction((key) => window.readerRace.backReady && window.readerRace.pending.includes(key), key);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('moke:native-back', { detail: { target: '/shelf' } })));
    await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
    const before = await calls(page);
    await releaseReaderIPC(page, key, true);
    await page.waitForTimeout(1_600);
    expect(await calls(page)).toEqual(before);
    await expect(page).toHaveURL(APP_URL + '/shelf');
  });
}

for (const runtime of ['android', 'ios', 'linux']) {
  test(`uncancelled ${runtime} detail survives continue consumption and can open again`, async ({ page }) => {
    await installReaderCancellationMock(page, { runtime });
    await page.goto(APP_URL + detail());
    await page.waitForFunction(() => window.readerRace.backReady && !location.search.includes('continue=1') && window.readerRace.pending.includes('42'));
    await expect(page).not.toHaveURL(/continue=1/);
    expect(new URL(page.url()).searchParams.get('source')).toBe(LAYOUT_SERVER_URL);
    await releaseReaderIPC(page, '42');
    if (runtime === 'ios') {
      // iOS location.assign is a full document handoff, so use its mock document.
      await expect(page).toHaveURL(/\/readest\/reader\?/);
    } else {
      expect(await calls(page)).toHaveLength(1);
      if (runtime === 'linux') {
        await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event('moke:continue-reading-request')));
        await expect.poll(async () => (await calls(page)).length).toBe(2);
        await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
      }
    }
  });
}
