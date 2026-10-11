import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  workers: 1,
  expect: { timeout: 5000 },
  use: {
    headless: true,
    navigationTimeout: 60000,
    launchOptions: process.env.MOKE_TEST_CHROMIUM_PATH ? { executablePath: process.env.MOKE_TEST_CHROMIUM_PATH } : {},
  },
});
