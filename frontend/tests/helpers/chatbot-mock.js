import { expect } from '@playwright/test';

export const TOKEN_KEY = 'petcare.auth.token.v1';
export const users = {
  a: { user_id: 960001, full_name: 'Khách chatbot A', email: 'chat-a@example.test', role: 'user', status: 'active' },
  b: { user_id: 960002, full_name: 'Khách chatbot B', email: 'chat-b@example.test', role: 'user', status: 'active' },
  admin: { user_id: 960003, full_name: 'Quản trị chatbot', email: 'chat-admin@example.test', role: 'admin', status: 'active' },
};
export const tokenFor = owner => `chat-test-${owner}-token`;
export const sessionFor = owner => `${(owner === 'a' ? 'A' : owner === 'b' ? 'B' : 'G').repeat(43)}.${'S'.repeat(43)}`;
export const categories = ['Thức ăn thú cưng', 'Đồ chơi thú cưng', 'Phụ kiện thú cưng', 'Vệ sinh thú cưng', 'Dinh dưỡng bổ sung'].map((name, index) => ({ category_id: index + 1, name, description: '' }));
export const products = Array.from({ length: 8 }, (_, index) => ({
  product_id: index + 1, category_id: index % 5 + 1,
  category_name: categories[index % 5].name,
  name: `Sản phẩm chatbot thử nghiệm ${index + 1}`, description: 'Dữ liệu tổng hợp chỉ dùng cho kiểm thử giao diện.',
  price: `${125000 + index * 1000}.00`, stock_quantity: 8,
  image_url: '/images/products/chat-test.webp', status: 'Đang bán', available: true, source: 'MySQL',
}));
const emptyCart = { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00', selected_subtotal: '0.00', selected_quantity: 0, selected_count: 0 };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Authorization,Content-Type',
  'access-control-expose-headers': 'Retry-After',
};
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#eef7ff"/></svg>';

export function chatReply(request, changes = {}, owner = 'guest') {
  return {
    success: true, session_id: request.session_id || sessionFor(owner), request_id: request.request_id,
    message: 'Bạn có thể tham khảo lựa chọn trong thẻ sản phẩm bên dưới.',
    products: [products[0]], follow_up: 'Bạn muốn tìm trong khoảng ngân sách nào?', warnings: [],
    code: 'OK', replayed: false, mode: 'product', intent: 'product_search', model: 'mock-model',
    ...changes,
  };
}

// Only the selected Vite origin can reach a server. All APIs, including the
// catalog/auth/cart requests made by the application shell, are in-memory stubs.
export async function mockChatbot(page, { frontendOrigin = 'http://127.0.0.1:5183', owner = null, onChat } = {}) {
  const calls = [], unexpected = [], blockedExternal = [], apiRequests = [];
  if (owner) await page.addInitScript(({ key, token }) => {
    if (!sessionStorage.getItem('petcare.chat-test-seeded')) {
      sessionStorage.setItem('petcare.chat-test-seeded', '1');
      sessionStorage.setItem(key, token);
    }
  }, { key: TOKEN_KEY, token: tokenFor(owner) });

  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const authorization = request.headers().authorization;
    const actor = Object.keys(users).find(name => authorization === `Bearer ${tokenFor(name)}`);
    const fulfill = (body, status = 200, headers = {}) => route.fulfill({ status, headers: { ...CORS, ...headers }, json: body });
    if (path.startsWith('/api/')) {
      apiRequests.push({ path, method });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (path === '/api/products' && method === 'GET') return fulfill({ success: true, products });
      if (path === '/api/categories' && method === 'GET') return fulfill({ success: true, categories });
      if (path === '/api/vouchers/readiness' && method === 'GET') return fulfill({ success: true, readiness: { ready: false, online_ready: false } });
      if (path === '/api/cart/preview' && method === 'POST') return fulfill({ success: true, cart: emptyCart });
      if (path === '/api/cart' && method === 'GET') return fulfill({ success: true, cart: emptyCart });
      if (path === '/api/auth/me' && method === 'GET') return actor
        ? fulfill({ success: true, user: users[actor] })
        : fulfill({ success: false, message: 'Invalid or expired token' }, 401);
      if (path === '/api/auth/login' && method === 'POST') {
        const email = request.postDataJSON().email;
        const selected = Object.keys(users).find(name => users[name].email === email);
        return selected ? fulfill({ success: true, token: tokenFor(selected), user: users[selected] })
          : fulfill({ success: false, message: 'Invalid email or password' }, 401);
      }
      if (path === '/api/chat' && method === 'POST') {
        const body = request.postDataJSON();
        const call = { body, authorization, owner: actor || 'guest', index: calls.length };
        calls.push(call);
        const result = onChat ? await onChat(call) : { body: chatReply(body, {}, actor || 'guest') };
        if (result?.abort) return route.abort('failed');
        return fulfill(result?.body || chatReply(body, {}, actor || 'guest'), result?.status || 200, result?.headers);
      }
      unexpected.push({ path, method });
      return route.abort('blockedbyclient');
    }
    if (url.origin === new URL(frontendOrigin).origin) {
      if (path === '/images/products/chat-test.webp') return route.fulfill({ contentType: 'image/svg+xml', body: image });
      return route.continue();
    }
    blockedExternal.push(request.url());
    if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: image });
    return route.abort('blockedbyclient');
  });
  return { calls, unexpected, blockedExternal, apiRequests };
}

export async function openChat(page) {
  await page.getByRole('button', { name: 'Mở AI Chatbot', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Chatbot PetCareShop' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' })).toBeEnabled();
  return dialog;
}

export async function sendChat(page, message) {
  const input = page.getByRole('textbox', { name: 'Nội dung tin nhắn' });
  await input.fill(message);
  await input.press('Enter');
}

export async function loginChatUser(page, owner) {
  await page.goto('/login?returnTo=%2F');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(users[owner].email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Chat-mock-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/');
}

export function expectOnlyMockedApis(state) {
  expect(state.unexpected).toEqual([]);
  expect(state.apiRequests.filter(({ path }) => /^\/api\/(?:orders|payments|admin\/|vouchers\/quote)/.test(path))).toEqual([]);
}
