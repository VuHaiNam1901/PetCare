import { expect } from '@playwright/test';

export const API = process.env.MY_ORDERS_API_ORIGIN || 'http://localhost:3000';
export const statuses = ['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'];
export const TOKEN_KEY = 'petcare.auth.token.v1';
export const users = {
  a: { user_id: 920001, full_name: 'Khách hàng A', email: 'orders-a@example.test', role: 'user', status: 'active' },
  b: { user_id: 920002, full_name: 'Khách hàng B', email: 'orders-b@example.test', role: 'user', status: 'active' },
  admin: { user_id: 920003, full_name: 'Quản trị viên kiểm thử', email: 'orders-admin@example.test', role: 'admin', status: 'active' },
};
export const tokenFor = owner => `my-orders-${owner}-token`;
export const formatPrice = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(value));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };
const emptyCart = { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00', selected_subtotal: '0.00', selected_quantity: 0, selected_count: 0 };

export function orderFixture(orderId, owner = 'a', changes = {}) {
  return {
    order_id: orderId, user_id: users[owner].user_id,
    order_date: '2026-10-31T08:15:00.000Z', total_amount: '250000.00', status: 'Chờ xử lý',
    recipient_name: users[owner].full_name, shipping_address: '123 Đường Kiểm Thử', phone: '0987654321', note: null,
    payment_method: 'COD', payment_status: 'Chưa thanh toán', approved_at: null,
    items: [{ order_detail_id: orderId * 10, product_id: 1, name: `Sản phẩm đơn ${orderId}`, image_url: '/images/products/1-me-o-tuna-thuc-an-hat-cho-meo-vi-ca-ngu-1-2kg.webp', quantity: 2, unit_price: '125000.00', subtotal: '250000.00' }],
    ...changes,
  };
}

export function paymentFixture(order, changes = {}) {
  return {
    payment_id: order.order_id, order_id: order.order_id,
    payment_method: order.payment_method, payment_status: order.payment_status,
    amount: order.payment_amount || order.total_amount, transaction_date: order.transaction_date || null,
    created_at: order.order_date, order_status: order.status, approved_at: order.approved_at,
    can_simulate: order.payment_method === 'ONLINE' && Boolean(order.approved_at) && order.status === 'Chờ thanh toán'
      && ['Chưa thanh toán', 'Thất bại'].includes(order.payment_status) && !order.transaction_date,
    simulation_only: true,
    ...changes,
  };
}

// These are invented orders for browser tests only. Every read is owner-scoped
// by the fixture token, and every unexpected write is aborted before any server.
export async function mockMyOrders(page, {
  owner = 'a', orders, hold = false, fail = null,
  detailHold = false, detailFail = null, paymentFail = null, paymentOverrides = {},
} = {}) {
  const rows = orders || [
    ...Array.from({ length: 12 }, (_, index) => orderFixture(501 + index, 'a', { status: statuses[index % statuses.length] })),
    orderFixture(9901, 'b', { items: [{ ...orderFixture(9901, 'b').items[0], name: 'Đơn riêng chỉ thuộc tài khoản B' }] }),
  ];
  const reads = [], detailReads = [], paymentReads = [], writes = [], unexpected = [];
  let failure = fail;
  let detailFailure = detailFail, paymentFailure = paymentFail;
  let gateResolve;
  let gate = hold ? new Promise(resolve => { gateResolve = resolve; }) : null;
  let detailGateResolve;
  let detailGate = detailHold ? new Promise(resolve => { detailGateResolve = resolve; }) : null;
  await page.addInitScript(({ key, token }) => {
    if (sessionStorage.getItem('petcare.my-orders-test-seeded')) return;
    sessionStorage.setItem('petcare.my-orders-test-seeded', '1');
    if (token) sessionStorage.setItem(key, token);
  }, { key: TOKEN_KEY, token: owner ? tokenFor(owner) : null });

  await page.route(`${API}/api/**`, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const token = request.headers().authorization?.replace(/^Bearer /, '');
    const actor = Object.keys(users).find(name => token === tokenFor(name));
    const json = (body, status = 200) => route.fulfill({ status, headers: CORS, json: { success: true, ...body } });
    const reject = (status, message) => route.fulfill({ status, headers: CORS, json: { success: false, message } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/api/products' || path === '/api/categories' || path === '/api/cart/preview') return route.continue();
    if (!['GET', 'HEAD'].includes(method)) writes.push({ path, method });
    if (path === '/api/auth/me' && method === 'GET') return actor ? json({ user: users[actor] }) : reject(401, 'Invalid or expired token');
    if (path === '/api/auth/login' && method === 'POST') {
      const selected = request.postDataJSON().email === users.b.email ? 'b' : 'a';
      return json({ token: tokenFor(selected), token_type: 'Bearer', expires_in: 3600, user: users[selected] });
    }
    if (path === '/api/auth/register' && method === 'POST') return json({ user: users.a }, 201);
    if (path === '/api/cart' && method === 'GET') return actor ? json({ cart: emptyCart }) : reject(401, 'Invalid or expired token');
    if (path === '/api/orders' && method === 'GET') {
      reads.push({ url: request.url(), token, query: Object.fromEntries(url.searchParams) });
      if (!actor) return reject(401, 'Invalid or expired token');
      if (actor === 'admin') return reject(403, 'Insufficient permissions');
      if (gate) await gate;
      if (failure) {
        const current = failure; failure = null;
        return reject(current.status, current.message || 'Order history is temporarily unavailable');
      }
      const pageNumber = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 20), status = url.searchParams.get('status');
      const selected = rows.filter(order => order.user_id === users[actor].user_id && (!status || order.status === status)).sort((a, b) => b.order_id - a.order_id);
      return json({ page: pageNumber, limit, total: selected.length, statuses, orders: selected.slice((pageNumber - 1) * limit, pageNumber * limit) });
    }
    const detail = path.match(/^\/api\/orders\/([^/]+)(\/payment)?$/);
    if (detail && method === 'GET') {
      const isPayment = Boolean(detail[2]);
      (isPayment ? paymentReads : detailReads).push({ url: request.url(), token, query: Object.fromEntries(url.searchParams) });
      if (!actor) return reject(401, 'Invalid or expired token');
      if (actor === 'admin') return reject(403, 'Insufficient permissions');
      if (!/^[1-9]\d*$/.test(detail[1]) || Number(detail[1]) > 2147483647 || url.searchParams.size) return reject(400, 'Invalid order request');
      if (!isPayment && detailGate) await detailGate;
      const current = isPayment ? paymentFailure : detailFailure;
      if (current) {
        if (isPayment) paymentFailure = null; else detailFailure = null;
        if (current.network) return route.abort('failed');
        return reject(current.status, current.message || 'Order details are temporarily unavailable');
      }
      const order = rows.find(row => row.order_id === Number(detail[1]) && row.user_id === users[actor].user_id);
      if (!order) return reject(404, 'Order not found');
      return isPayment ? json({ payment: paymentFixture(order, paymentOverrides[order.order_id]) }) : json({ order });
    }
    if (path.startsWith('/api/orders')) {
      unexpected.push({ path, method });
      return reject(405, 'Only authenticated read-only order endpoints are exposed');
    }
    if (['GET', 'HEAD'].includes(method)) return route.continue();
    unexpected.push({ path, method });
    return route.abort();
  });
  return {
    orders: rows, reads, detailReads, paymentReads, writes, unexpected,
    release: () => { gateResolve?.(); gate = null; },
    failNext: (status, message) => { failure = { status, message }; },
    releaseDetail: () => { detailGateResolve?.(); detailGate = null; },
    failNextDetail: (status, message) => { detailFailure = { status, message }; },
    failNextPayment: (status, message) => { paymentFailure = { status, message }; },
  };
}

export async function loginForOrders(page, owner = 'a', destination = '/my-orders') {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(users[owner].email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('MyOrders-test-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === destination);
}

export function expectNoOrderMutations(account) {
  expect(account.writes.filter(write => !/^\/api\/auth\/(login|register)$/.test(write.path))).toEqual([]);
  expect(account.unexpected).toEqual([]);
}
