import { expect } from '@playwright/test';

export const API = process.env.CHECKOUT_API_ORIGIN || 'http://localhost:3000';
export const formatPrice = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(value));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };

export async function catalogProducts(request) {
  const response = await request.get(`${API}/api/products`);
  expect(response.ok()).toBe(true);
  const { products } = await response.json();
  const available = products.filter(product => Number(product.stock_quantity) >= 8);
  expect(available.length).toBeGreaterThanOrEqual(3);
  return available;
}

// Account/order mutations are handled exclusively in memory. With
// playwright.checkout.config.js, even catalog/preview use a synthetic server.
export async function checkoutAccount(page, products, initialItems = [], overrides = {}) {
  const user = { user_id: 910001, full_name: 'Nguyễn Khách Hàng', email: 'checkout-ui@example.test', phone: '0987654321', address: '123 Nguyễn Trãi, Quận 1, TP Hồ Chí Minh', role: 'user', status: 'active', ...overrides };
  let items = initialItems.map(item => ({ ...item }));
  const writes = [];
  const unexpected = [];
  const committed = new Map();
  const orderKeys = new Map();
  const orders = [];
  const catalog = products.map(product => ({ ...product }));
  let expired = false;
  let nextOrderFailure = null;
  let loseNextOrderResponse = false;
  let orderDelay = 0;
  const asCart = () => {
    const rows = items.map((item, index) => {
      const product = catalog.find(product => product.product_id === item.product_id);
      return { ...product, ...item, cart_item_id: index + 2001, available: product.status === 'Đang bán' && item.quantity <= product.stock_quantity && product.stock_quantity > 0, line_total: (Number(product.price) * item.quantity).toFixed(2), availability_message: '' };
    });
    const selected = rows.filter(item => item.selected && item.available);
    return { cart_id: 6001, items: rows, total_quantity: rows.reduce((sum, item) => sum + item.quantity, 0), subtotal: rows.reduce((sum, item) => sum + Number(item.line_total), 0).toFixed(2), selected_subtotal: selected.reduce((sum, item) => sum + Number(item.line_total), 0).toFixed(2) };
  };
  await page.route(`${API}/api/**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = body => route.fulfill({ headers: CORS, json: { success: true, ...body } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/api/cart/preview') return route.continue();
    if (!['GET', 'HEAD'].includes(method)) writes.push({ path, method, body: request.postDataJSON(), key: request.headers()['idempotency-key'], authorization: request.headers().authorization });
    if (path === '/api/auth/login' && method === 'POST') {
      expired = false;
      return json({ token: 'checkout-ui-token', token_type: 'Bearer', expires_in: 3600, user });
    }
    if (path === '/api/auth/register' && method === 'POST') return route.fulfill({ status: 201, headers: CORS, json: { success: true, user } });
    if (path === '/api/auth/me' && method === 'GET') return expired
      ? route.fulfill({ status: 401, headers: CORS, json: { success: false, message: 'Invalid or expired token' } })
      : json({ user });
    if (path === '/api/cart' && method === 'GET') return json({ cart: asCart() });
    if (path === '/api/orders' && method === 'POST') {
      if (expired) return route.fulfill({ status: 401, headers: CORS, json: { success: false, message: 'Invalid or expired token' } });
      if (nextOrderFailure) {
        const failure = nextOrderFailure;
        nextOrderFailure = null;
        return route.fulfill({ status: failure.status, headers: CORS, json: { success: false, message: failure.message } });
      }
      const input = request.postDataJSON();
      const key = request.headers()['idempotency-key'];
      const fingerprint = JSON.stringify(input);
      if (!key || !request.headers().authorization) return route.fulfill({ status: 400, headers: CORS, json: { success: false, message: 'Order requires auth and an idempotency key' } });
      if (orderKeys.has(key)) {
        const stored = orderKeys.get(key);
        if (stored.fingerprint !== fingerprint) return route.fulfill({ status: 409, headers: CORS, json: { success: false, message: 'Idempotency-Key already used for a different request' } });
        return json({ order: stored.order, replayed: true });
      }
      const lines = input.items.map(item => {
        const product = catalog.find(candidate => candidate.product_id === item.product_id);
        return { ...product, ...item, unit_price: product.price, subtotal: (Number(product.price) * item.quantity).toFixed(2) };
      });
      if (lines.some(line => line.quantity > line.stock_quantity || line.status !== 'Đang bán')) return route.fulfill({ status: 409, headers: CORS, json: { success: false, message: 'Insufficient stock or invalid cart quantity' } });
      if (input.source === 'cart' && lines.some(line => !items.some(item => item.product_id === line.product_id && item.quantity >= line.quantity))) return route.fulfill({ status: 409, headers: CORS, json: { success: false, message: 'Selected cart items are no longer available' } });
      const order = { order_id: 7001 + orders.length, user_id: user.user_id, recipient_name: input.recipient_name, shipping_address: input.shipping_address, phone: input.phone, note: input.note || null, payment_method: input.payment_method, payment_status: 'Chưa thanh toán', status: input.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán', approved_at: null, total_amount: lines.reduce((sum, line) => sum + Number(line.subtotal), 0).toFixed(2), items: lines };
      if (input.source === 'cart') items = items.map(item => ({ ...item, quantity: item.quantity - (input.items.find(line => line.product_id === item.product_id)?.quantity || 0) })).filter(item => item.quantity > 0);
      for (const line of lines) catalog.find(product => product.product_id === line.product_id).stock_quantity -= line.quantity;
      orders.push(order);
      orderKeys.set(key, { fingerprint, order });
      if (orderDelay) await new Promise(resolve => setTimeout(resolve, orderDelay));
      if (loseNextOrderResponse) { loseNextOrderResponse = false; return route.abort('failed'); }
      return route.fulfill({ status: 201, headers: CORS, json: { success: true, order, replayed: false } });
    }
    if (path === '/api/cart/selection' && method === 'PUT') {
      const selected = request.postDataJSON().product_ids;
      items = items.map(item => ({ ...item, selected: selected.includes(item.product_id) }));
      return json({ cart: asCart() });
    }
    if (path === '/api/cart/merge' && method === 'POST') {
      const incoming = request.postDataJSON().items;
      const key = request.headers()['idempotency-key'];
      const replayed = committed.has(key);
      if (!committed.has(key)) {
        items = items.map(item => ({ ...item, selected: false }));
        for (const item of incoming) {
          const existing = items.find(candidate => candidate.product_id === item.product_id);
          if (existing) { existing.quantity += item.quantity; existing.selected = Boolean(item.selected); }
          else items.push({ ...item });
        }
        committed.set(key, true);
      }
      return json({ cart: asCart(), replayed });
    }
    if (['GET', 'HEAD'].includes(method)) return route.continue();
    unexpected.push({ path, method });
    await route.abort();
  });
  return {
    user, cart: asCart, writes, unexpected, orders,
    orderWrites: () => writes.filter(write => write.path === '/api/orders'),
    expireMe: () => { expired = true; },
    failNextOrder: (status, message = 'Order request failed') => { nextOrderFailure = { status, message }; },
    loseOrderResponse: () => { loseNextOrderResponse = true; },
    delayOrder: milliseconds => { orderDelay = milliseconds; },
    updateProduct: (productId, patch) => Object.assign(catalog.find(product => product.product_id === productId), patch),
  };
}

export async function loginAccount(page, destination = /\/$/) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('checkout-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CheckoutUiOnly123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

export async function seedGuest(page, items) {
  await page.goto('/');
  await page.evaluate(value => localStorage.setItem('petcare.guest-cart.v1', JSON.stringify({ version: 1, items: value })), items);
  await page.goto('/cart');
  await expect(page.locator('.cart-row')).toHaveCount(items.length);
}

export async function beginAccountCheckout(page, products, items, overrides) {
  const account = await checkoutAccount(page, products, items, overrides);
  await page.goto('/login');
  await loginAccount(page);
  await page.goto('/cart');
  await expect(page.locator('.cart-row')).toHaveCount(items.length);
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/checkout(?:\?.*)?$/);
  await expect(page.locator('.checkout-page')).toBeVisible();
  return account;
}

export function expectNoOrderWrites(account) {
  expect(account.writes.filter(write => /^\/api\/(?:orders|payments|users\/me)(?:\/|$)/.test(write.path))).toEqual([]);
  expect(account.unexpected).toEqual([]);
}
