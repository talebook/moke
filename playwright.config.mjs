import { defineConfig } from '@playwright/test';

// Start dev-preview separately. These specs use fictional HTTP/native fixtures.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  outputDir: './test-results',
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
});
