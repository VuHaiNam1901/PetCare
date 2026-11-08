import { orderFixture, statuses, users } from './my-orders-fixtures.js';

export { users };
export const API = process.env.ADMIN_ORDERS_API_ORIGIN || 'http://127.0.0.1:3103';
const TOKEN_KEY = 'petcare.auth.token.v1';
const tokenFor = actor => `admin-orders-${actor}-token`;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };
const emptyCart = { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00', selected_subtotal: '0.00', selected_quantity: 0, selected_count: 0 };

export function adminOrder(orderId = 801, changes = {}) {
  const order = orderFixture(orderId, 'a', { history: [], rejection_reason: null, stock_reserved_at: '2026-10-31T08:15:00.000Z', ...changes });
  order.approval_state = changes.approval_state || (order.rejection_reason ? 'rejected' : order.approved_at ? 'approved' : 'pending');
  order.allowed_actions = changes.allowed_actions || actions(order);
  return order;
}

function actions(order) {
  if (order.status === 'Đã hủy' || order.status === 'Đã giao hàng') return [];
  if (!order.approved_at) return ['approve', 'reject'];
  if (order.status === 'Chờ giao hàng') return ['ship'];
  if (order.status === 'Đang giao hàng') return ['deliver'];
  return [];
}

// Every response/order/account is invented. Unexpected writes are aborted; this
// browser suite cannot reach a real MySQL backend, even if a mock is missing.
export async function mockAdminOrders(page, { owner = 'admin', orders, hold = false, holdMutation = false, fail = null, mutationFail = null } = {}) {
  const rows = orders || Array.from({ length: 23 }, (_, index) => adminOrder(801 + index, { phone: index === 0 ? '0912345678' : '0987654321' }));
  const reads = [], writes = [], unexpected = [];
  let readFailure = fail, writeFailure = mutationFail;
  let releaseRead, releaseWrite;
  let readGate = hold ? new Promise(resolve => { releaseRead = resolve; }) : null;
  let writeGate = holdMutation ? new Promise(resolve => { releaseWrite = resolve; }) : null;
  await page.addInitScript(({ key, value }) => {
    if (sessionStorage.getItem('petcare.admin-orders-test-seeded')) return;
    sessionStorage.setItem('petcare.admin-orders-test-seeded', '1');
    if (value) sessionStorage.setItem(key, value);
  }, { key: TOKEN_KEY, value: owner ? tokenFor(owner) : null });
  await page.route(`${API}/api/**`, async route => {
    const request = route.request(), method = request.method(), url = new URL(request.url()), path = url.pathname;
    const actor = Object.keys(users).find(key => request.headers().authorization === `Bearer ${tokenFor(key)}`);
    const json = (body, status = 200) => route.fulfill({ status, headers: CORS, json: { success: true, ...body } });
    const reject = (status, message) => route.fulfill({ status, headers: CORS, json: { success: false, message } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (['/api/products', '/api/categories', '/api/cart/preview'].includes(path)) return route.continue();
    if (path === '/api/auth/me' && method === 'GET') return actor ? json({ user: users[actor] }) : reject(401, 'Invalid or expired token');
    if (path === '/api/auth/login' && method === 'POST') {
      const selected = request.postDataJSON().email === users.admin.email ? 'admin' : 'a';
      return json({ token: tokenFor(selected), token_type: 'Bearer', expires_in: 3600, user: users[selected] });
    }
    if (path === '/api/cart' && method === 'GET') return actor ? json({ cart: emptyCart }) : reject(401, 'Invalid token');
    if (path.startsWith('/api/admin/orders')) {
      if (method === 'GET') reads.push({ path, query: Object.fromEntries(url.searchParams), actor });
      else writes.push({ path, method, body: request.postDataJSON(), actor });
      if (!actor) return reject(401, 'Invalid or expired token');
      if (actor !== 'admin') return reject(403, 'Insufficient permissions');
      if (method === 'GET') {
        if (readGate) await readGate;
        if (readFailure) { const current = readFailure; readFailure = null; return reject(current.status, current.message || 'Admin orders unavailable'); }
      }
      if (path === '/api/admin/orders' && method === 'GET') {
        const pageNumber = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 20);
        const status = url.searchParams.get('status'), approval = url.searchParams.get('approval'), q = (url.searchParams.get('q') || '').replace(/^#/, '');
        const selected = rows.filter(order => (!status || order.status === status) && (!approval || order.approval_state === approval) &&
          (!q || String(order.order_id) === q || order.phone.includes(q))).sort((a, b) => b.order_id - a.order_id);
        return json({ page: pageNumber, limit, total: selected.length, statuses, orders: selected.slice((pageNumber - 1) * limit, pageNumber * limit) });
      }
      const match = path.match(/^\/api\/admin\/orders\/([1-9]\d*)(?:\/(approve|reject|status))?$/);
      const order = match && rows.find(row => row.order_id === Number(match[1]));
      if (!order) return reject(404, 'Order not found');
      if (method === 'GET' && !match[2]) return json({ order });
      if (method === 'PATCH' && match[2]) {
        if (writeGate) await writeGate;
        if (writeFailure) { const current = writeFailure; writeFailure = null; return reject(current.status, current.message || 'Order changed; reload before retrying'); }
        const input = request.postDataJSON(), action = match[2], from = order.status;
        if (action === 'approve') {
          if (!order.allowed_actions.includes('approve')) return reject(409, 'Order cannot be approved');
          order.approved_at = '2026-10-31T10:00:00.000Z'; order.approval_state = 'approved';
          if (order.payment_method === 'COD') order.status = 'Chờ giao hàng';
        } else if (action === 'reject') {
          if (!order.allowed_actions.includes('reject') || !input.reason?.trim()) return reject(409, 'A pending order and refusal reason are required');
          order.status = 'Đã hủy'; order.payment_status = 'Đã hủy'; order.approval_state = 'rejected'; order.rejection_reason = input.reason.trim();
        } else {
          const expected = order.status === 'Chờ giao hàng' ? 'Đang giao hàng' : order.status === 'Đang giao hàng' ? 'Đã giao hàng' : null;
          if (input.status !== expected || (order.payment_method === 'ONLINE' && order.payment_status !== 'Đã thanh toán')) return reject(409, 'Invalid status transition');
          if (input.status === 'Đã giao hàng' && order.payment_method === 'COD') {
            if (input.cod_payment_received !== true) return reject(409, 'Cash confirmation required');
            order.payment_status = 'Đã thanh toán'; order.transaction_date = '2026-10-31T10:00:00.000Z';
          }
          order.status = input.status;
        }
        order.allowed_actions = actions(order);
        order.history.push({ history_id: order.history.length + 1, from_status: from, to_status: order.status, action, actor_id: users.admin.user_id,
          actor_name: users.admin.full_name, created_at: '2026-10-31T10:00:00.000Z', reason: input.reason || null });
        return json({ order });
      }
      return reject(405, 'Unsupported fixture method');
    }
    unexpected.push({ path, method });
    return route.abort();
  });
  return { orders: rows, reads, writes, unexpected, release: () => { releaseRead?.(); readGate = null; }, releaseMutation: () => { releaseWrite?.(); writeGate = null; } };
}
