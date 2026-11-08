import { createServer } from 'node:http';
import { checkoutProducts, checkoutCategories, previewCart } from './checkout-catalog.js';

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const json = (status, body) => { response.writeHead(status, headers); response.end(JSON.stringify(body)); };
  if (request.method === 'OPTIONS') { response.writeHead(204, headers); return response.end(); }
  if (request.method === 'GET' && path === '/api/products') return json(200, { success: true, products: checkoutProducts });
  if (request.method === 'GET' && path === '/api/categories') return json(200, { success: true, categories: checkoutCategories });
  if (request.method === 'POST' && path === '/api/cart/preview') {
    try {
      let data = '';
      for await (const chunk of request) { data += chunk; if (data.length > 50000) throw new Error('Input too large'); }
      const { items } = JSON.parse(data);
      if (!Array.isArray(items) || items.length > 100 || items.some(item => !Number.isInteger(item.product_id) || !Number.isInteger(item.quantity) || item.quantity <= 0)) throw new Error('Invalid items');
      return json(200, { success: true, cart: previewCart(items) });
    } catch { return json(400, { success: false, message: 'Invalid synthetic preview input' }); }
  }
  // No mutation fallback is exposed, even if a browser mock is missing.
  return json(405, { success: false, message: 'Checkout test server only serves a synthetic catalog and read-only preview' });
});
server.listen(Number(process.env.CHECKOUT_API_PORT || 3101), '127.0.0.1', () => console.log('Synthetic checkout catalog ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
