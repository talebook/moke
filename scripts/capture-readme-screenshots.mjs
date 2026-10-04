// Capture the real Web UI with fictional, browser-local Talebook responses.
// Start `pnpm dev-web --hostname 127.0.0.1 --port 3100` first.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const appUrl = 'http://127.0.0.1:3100';
const serverUrl = 'https://readme-library.invalid';
const outputDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const titles = ['山间来信', '城市漫步', '星河手记', '草木之间', '海风与旅人', '时间的花园',
  '纸上远行', '午后书店', '雨天的诗', '湖畔笔记', '慢慢生活', '光与四季'];
const authors = ['林远', '顾川', '江宁', '许青'];
const palettes = [
  ['#244b43', '#f2e7ca'], ['#b35337', '#fff0d2'], ['#253f63', '#e5d9ba'],
  ['#727d57', '#f7f0d7'], ['#477b86', '#eaf2e4'], ['#93754d', '#f8e6b7'],
];
const books = titles.map((title, index) => ({
  id: String(index + 1), title, authors: [{ name: authors[index % authors.length] }],
  img: `/covers/${index + 1}.svg`, publisher: '墨客示例出版社', pubdate: '2026-01-01',
  tags: ['文学', '随笔'], language: '中文', rating: 4.5,
  comments: '<p>沿着山间的小路，记录风、树木与日常生活。十二封写给远方的信，' +
    '从清晨的薄雾到夜晚的星光，带你在阅读中发现平凡时刻的美好。</p>' +
    '<p>这是为 Moke 应用展示编写的虚构书籍简介，不对应实际出版物。</p>',
  files: [{ format: 'epub', size: 524288 }, { format: 'pdf', size: 2097152 }],
  state: { wants: false, read_state: 0, download: 0 },
}));

// Original geometric cover illustrations: no external images or fonts.
function coverSvg(index) {
  const [background, ink] = palettes[index % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <rect width="400" height="600" fill="${background}"/>
    <rect x="22" y="22" width="356" height="556" rx="2" fill="none" stroke="${ink}" opacity=".45"/>
    <text x="48" y="77" fill="${ink}" font-family="sans-serif" font-size="12" letter-spacing="4">MOKE LIBRARY</text>
    <text x="48" y="151" fill="${ink}" font-family="serif" font-size="42">FIELD</text>
    <text x="48" y="201" fill="${ink}" font-family="serif" font-size="42">NOTES ${String(index + 1).padStart(2, '0')}</text>
    <circle cx="${240 + index % 3 * 18}" cy="315" r="48" fill="${ink}" opacity=".9"/>
    <path d="M22 468 L120 328 L225 457 L306 375 L378 478 L378 530 L22 530Z" fill="${ink}" opacity=".25"/>
    <path d="M22 506 L151 403 L274 506 L330 450 L378 507 L378 530 L22 530Z" fill="${ink}" opacity=".5"/>
    <text x="48" y="560" fill="${ink}" font-family="sans-serif" font-size="11" letter-spacing="3">A FICTIONAL COLLECTION</text>
  </svg>`;
}

export async function captureReadmeScreenshots(page) {
  await mkdir(outputDir, { recursive: true });
  const diagnostics = [];
  const context = page.context();
  page.setDefaultNavigationTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addInitScript(({ appUrl, serverUrl }) => {
    if (location.origin !== appUrl) return;
    // Seed only the disposable browser context; no real sessions are reused.
    const saved = JSON.parse(localStorage.getItem('moke-server-storage') || '{}');
    if (saved.state?.serverUrl !== serverUrl) {
      localStorage.setItem('moke-server-storage', JSON.stringify({ version: 0, state: {
        serverUrl, serverTitle: '墨客示例书库', isConnected: true, user: null, token: '',
        protocol: 'https', host: 'readme-library.invalid', port: '', offlineMode: false,
        capabilities: { shelfApi: true, readingStateApi: true, readingProgressApi: true,
          readingStatsApi: false, networkSourcesApi: false, annotationApiStatus: 'unsupported',
          annotationApiCheckedAt: Date.now(), checkedAt: Date.now(), version: 'demo' },
      } }));
    }
  }, { appUrl, serverUrl });

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appUrl) return route.continue();
    if (url.origin === serverUrl) {
      const headers = { 'access-control-allow-origin': appUrl,
        'access-control-allow-credentials': 'true' };
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers });
      }
      const cover = url.pathname.match(/^\/covers\/(\d+)\.svg$/);
      if (cover) return route.fulfill({ contentType: 'image/svg+xml', headers,
        body: coverSvg(Number(cover[1]) - 1) });
      let data;
      if (url.pathname === '/api/library') data = { err: 'ok', books, total: books.length };
      if (url.pathname === '/api/book/nav') data = { err: 'ok', navs: [
        { legend: '分类', tags: [{ name: '文学', count: 12 }, { name: '随笔', count: 12 }] },
      ] };
      const detail = url.pathname.match(/^\/api\/book\/(\d+)$/);
      if (detail) data = { err: 'ok', book: books[Number(detail[1]) - 1] };
      if (data) return route.fulfill({ contentType: 'application/json', headers,
        body: JSON.stringify(data) });
    }
    diagnostics.push(`Unmocked request: ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', (error) => diagnostics.push(`Page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`Console error: ${message.text()} (${message.location().url})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
      diagnostics.push(`Failed request: ${request.url()} (${request.failure()?.errorText})`);
    }
  });

  async function ready() {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).filter((img) => img.getBoundingClientRect().top < innerHeight)
        .map(async (img) => { await img.decode(); }));
      assertNoOverflow();
      function assertNoOverflow() {
        if (document.documentElement.scrollWidth > innerWidth + 1) {
          throw new Error('Page has horizontal overflow');
        }
      }
    });
  }
  async function capture(name) {
    await ready();
    await page.screenshot({ path: `${outputDir}${name}.png`, animations: 'disabled' });
    console.log(`Captured ${name}: ${page.url()}, ${JSON.stringify(page.viewportSize())}`);
  }

  await page.goto(`${appUrl}/settings/developer`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '同意并继续' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.goto(`${appUrl}/library`, { waitUntil: 'networkidle' });
  const firstBook = page.locator('a[href="/detail?id=1"]').first();
  await expect(firstBook).toBeVisible();
  await expect(page.locator('.moke-sidebar')).toBeVisible();
  await capture('library-desktop');

  await page.getByRole('button', { name: '纯列表（表格）视图' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '网格视图' }).click();
  await firstBook.focus();
  await expect(firstBook).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: books[0].title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开更多出版信息' }).click();
  await capture('book-detail-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${appUrl}/library`, { waitUntil: 'networkidle' });
  await expect(firstBook).toBeVisible();
  await expect(page.locator('.moke-sidebar')).toBeHidden();
  await expect(page.locator('.moke-tab-bar')).toBeVisible();
  await capture('library-mobile');
  // The existing Web preview has no favicon.ico. Record it without treating
  // this unrelated, non-visible resource as a screenshot failure.
  const blockingDiagnostics = diagnostics.filter((message) => !message.includes(`${appUrl}/favicon.ico`));
  assert.deepEqual(blockingDiagnostics, [], `Browser diagnostics:\n${diagnostics.join('\n')}`);
  for (const message of diagnostics) console.log(`Known preview issue: ${message}`);
  console.log('Verified desktop/mobile layout, view switch, keyboard detail navigation; no blocking browser errors.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, locale: 'zh-CN' });
    await captureReadmeScreenshots(await context.newPage());
  } finally {
    await browser.close();
  }
}
