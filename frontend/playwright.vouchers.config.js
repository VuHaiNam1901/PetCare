import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// This suite serves frontend files only. Every API request is intercepted by
// its test fixture; it never starts the real backend or connects to MySQL.
export default defineConfig({
  ...base,
  testMatch: ['voucher-*.spec.js'],
  outputDir: `voucher-test-results/run-${Date.now()}-${process.pid}`,
  use: { ...base.use, baseURL: 'http://127.0.0.1:5179', timezoneId: 'Asia/Bangkok' },
  webServer: {
    command: 'npm.cmd run dev -- --host 127.0.0.1 --port 5179 --strictPort',
    url: 'http://127.0.0.1:5179', reuseExistingServer: false, timeout: 30000,
    env: { VITE_API_ORIGIN: 'http://127.0.0.1:3107' },
  },
});
