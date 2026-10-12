import { defineConfig } from '@playwright/test';
// Start dev-preview separately. These specs use fictional HTTP/native fixtures.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  expect: { timeout: 5000 },
  use: {
    headless: true,
    navigationTimeout: 60000,
    launchOptions: {
      executablePath: process.env.MOKE_TEST_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    },
  },
});
