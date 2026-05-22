import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3456',
    headless: true,
  },
  webServer: {
    command: 'node server.js',
    port: 3456,
    reuseExistingServer: true,
  },
});
