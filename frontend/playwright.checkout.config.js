import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const apiOrigin = 'http://127.0.0.1:3101';
process.env.CHECKOUT_API_ORIGIN = apiOrigin;

export default defineConfig({
  ...base,
  testMatch: ['checkout.spec.js', 'checkout-submit.spec.js', 'cart-auth.spec.js'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5174' },
  webServer: [
    { command: 'node tests/helpers/checkout-api-server.mjs', url: `${apiOrigin}/api/products`, reuseExistingServer: false, timeout: 15000 },
    { command: 'npm.cmd run dev -- --port 5174', url: 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 30000, env: { VITE_API_ORIGIN: apiOrigin } },
  ],
});
