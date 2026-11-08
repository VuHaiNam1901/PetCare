import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const apiOrigin = 'http://127.0.0.1:3102';
process.env.CHECKOUT_API_ORIGIN = apiOrigin;
process.env.MY_ORDERS_API_ORIGIN = apiOrigin;

export default defineConfig({
  ...base,
  testMatch: ['my-orders.spec.js', 'order-detail.spec.js'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5175' },
  webServer: [
    {
      command: 'node tests/helpers/checkout-api-server.mjs',
      url: `${apiOrigin}/api/products`,
      reuseExistingServer: false,
      timeout: 15000,
      env: { CHECKOUT_API_PORT: '3102' },
    },
    {
      command: 'npm.cmd run dev -- --port 5175',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
      timeout: 30000,
      env: { VITE_API_ORIGIN: apiOrigin },
    },
  ],
});
