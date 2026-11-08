import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const apiOrigin = 'http://127.0.0.1:3103';
process.env.CHECKOUT_API_ORIGIN = apiOrigin;
process.env.MY_ORDERS_API_ORIGIN = apiOrigin;
process.env.ADMIN_ORDERS_API_ORIGIN = apiOrigin;

export default defineConfig({
  ...base,
  testMatch: ['admin-orders.spec.js'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5176' },
  webServer: [
    { command: 'node tests/helpers/checkout-api-server.mjs', url: `${apiOrigin}/api/products`, reuseExistingServer: false, timeout: 15000, env: { CHECKOUT_API_PORT: '3103' } },
    { command: 'npm.cmd run dev -- --port 5176', url: 'http://127.0.0.1:5176', reuseExistingServer: false, timeout: 30000, env: { VITE_API_ORIGIN: apiOrigin } },
  ],
});
