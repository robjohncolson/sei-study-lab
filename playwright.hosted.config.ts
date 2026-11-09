import {defineConfig} from '@playwright/test';

const enabled = Boolean(process.env.SEI_TEST_ADMIN_DATABASE_URL);
export default defineConfig({
  testDir: 'apps/web/hosted-auth',
  testMatch: '**/hosted.spec.ts',
  use: {baseURL: 'http://127.0.0.1:5176', browserName: 'chromium', channel: 'msedge', trace: 'off', screenshot: 'off', video: 'off'},
  // No server or database is opened when this optional suite is not configured.
  webServer: enabled ? {command: 'node --import tsx scripts/hosted-e2e-server.ts', url: 'http://127.0.0.1:5176', reuseExistingServer: false, timeout: 60000} : undefined,
  workers: 1,
  retries: 0,
});
