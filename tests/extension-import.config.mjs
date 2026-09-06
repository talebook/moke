import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'extension-import.spec.mjs', workers: 1,
  use: { baseURL: 'http://127.0.0.1:32127', headless: true },
  webServer: {
    command: 'pnpm exec next dev --hostname 127.0.0.1 --port 32127',
    cwd: '..', url: 'http://127.0.0.1:32127/extensions', timeout: 120000,
    env: { NEXT_PUBLIC_APP_PLATFORM: 'tauri' }, reuseExistingServer: false,
  },
});
