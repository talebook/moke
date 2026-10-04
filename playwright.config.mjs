import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  // The dev server compiles routes on demand, including on slower ARM hosts.
  timeout: 180000,
  workers: 1,
  expect: { timeout: 45000 },
  use: {
    headless: true,
    navigationTimeout: 60000,
    launchOptions: process.env.MOKE_TEST_CHROMIUM_PATH ? { executablePath: process.env.MOKE_TEST_CHROMIUM_PATH } : {},
  },
});
