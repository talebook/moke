import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureReadmeScreenshots } from '../scripts/capture-readme-screenshots.mjs';

const BASE_URL = process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';

test('README capture reconnects explicitly after each cold document and retains desktop/mobile layouts', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const requests = [];
  page.on('request', (request) => requests.push(new URL(request.url())));
  const outputDir = testInfo.outputPath('readme-screenshots');
  await captureReadmeScreenshots(page, { appUrl: BASE_URL, outputDir });
  await expect(page).toHaveURL(`${new URL(BASE_URL).origin}/library`);
  const registry = await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')));
  expect(registry.version).toBe(1);
  expect(Object.keys(registry.state)).toEqual(['savedServers']);
  expect(registry.state.savedServers).toHaveLength(1);
  expect(requests.filter((url) => url.origin === 'https://readme-library.invalid' && url.pathname === '/api/welcome').length)
    .toBeGreaterThanOrEqual(2);
  for (const [name, width, height] of [
    ['library-desktop', 1440, 960], ['book-detail-desktop', 1440, 960], ['library-mobile', 390, 844],
  ]) {
    const png = await readFile(join(outputDir, `${name}.png`));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(width);
    expect(png.readUInt32BE(20)).toBe(height);
  }
});
