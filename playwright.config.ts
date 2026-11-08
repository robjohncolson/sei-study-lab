import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'apps/web',testMatch:'**/e2e.spec.ts',use:{baseURL:'http://127.0.0.1:5174',browserName:'chromium',channel:'msedge'},webServer:{command:'npx tsx scripts/e2e-server.ts',url:'http://127.0.0.1:5174',reuseExistingServer:false,timeout:30000},workers:1});
