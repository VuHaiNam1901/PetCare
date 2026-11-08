import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// Frontend only: every test intercepts APIs and denies external requests.
// No real Express server, Gemini call, database or commerce mutation is used.
export default defineConfig({
  ...base,
  testMatch: ['chatbot.spec.js', 'homepage-widgets.spec.js'],
  outputDir: `chat-test-results/run-${Date.now()}-${process.pid}`,
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:5183',
    serviceWorkers: 'block',
    timezoneId: 'Asia/Bangkok',
  },
  webServer: {
    command: 'npm.cmd run dev -- --host 127.0.0.1 --port 5183 --strictPort',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: false,
    timeout: 30000,
    env: { VITE_API_ORIGIN: 'http://127.0.0.1:3193' },
  },
});
