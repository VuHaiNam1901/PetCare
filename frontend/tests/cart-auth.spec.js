import { test, expect } from '@playwright/test';

const API = process.env.CHECKOUT_API_ORIGIN || 'http://localhost:3000';
const CORS_HEADERS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };
const price = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(value));
const row = (page, product) => page.locator(`.cart-row[data-product-id="${product.product_id}"]`);
const rowQuantity = (page, product) => row(page, product).getByRole('spinbutton', { name: `Số lượng ${product.name}`, exact: true });

async function expectCartBadge(page, count) {
  await expect(page.locator('.site-header .header-cart')).toHaveAttribute('aria-label', `Giỏ hàng, ${count} sản phẩm`);
  if (count) await expect(page.locator('.cart-count')).toHaveText(String(count));
  else await expect(page.locator('.cart-count')).toHaveCount(0);
}

// Later account fixtures handle writes in memory. Never let an unexpected UI
// mutation reach MySQL; the real guest preview endpoint only reads the catalog.
test.beforeEach(async ({ page }) => {
  await page.route(`${API}/api/**`, async route => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || new URL(request.url()).pathname === '/api/cart/preview') return route.continue();
    await route.abort();
    throw new Error(`Unexpected unmocked API mutation: ${request.method()} ${request.url()}`);
  });
});

async function catalog(request) {
  const response = await request.get(`${API}/api/products`);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const products = body.products.filter(product => Number(product.stock_quantity) >= 8);
  expect(products.length).toBeGreaterThanOrEqual(3);
  return products;
}

async function addFromDetail(page, product, quantity = 1) {
  await page.goto(`/products/${product.product_id}`);
  await expect(page.locator('#detail-title')).toHaveText(product.name);
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill(String(quantity));
  await page.locator('.detail-actions .add-to-cart').click();
  await expect(page.locator('.feature-notice')).toContainText(/Đã thêm|thêm.*thành công/i);
  await expect(page).toHaveURL(new RegExp(`/products/${product.product_id}$`));
}

async function login(page, destination = /\/checkout(?:\?.*)?$/) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('cart-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CartUiOnly123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

// These fixtures exercise browser state transitions only. Real JWT/DB ownership,
// transaction rollback and merge idempotency are covered by backend tests.
async function mockAccount(page, products, initialItems = [], options = {}) {
  let items = initialItems.map(item => ({ ...item }));
  const mergeKeys = [];
  const committed = new Map();
  let firstResponseLost = false;
  let holdMergeResponses = Boolean(options.loseFirstMergeResponse);
  let registerBody;
  let expiredToken = false;
  const user = { user_id: 900001, full_name: 'Cart UI test', email: 'cart-ui@example.test', role: options.role || 'user', status: 'active' };
  const asCart = () => {
    const rows = items.map((item, index) => {
      const product = products.find(product => product.product_id === item.product_id);
      return { ...product, ...item, cart_item_id: index + 1001, selected: Boolean(item.selected), available: product.status === 'Đang bán' && item.quantity <= product.stock_quantity && product.stock_quantity > 0, line_total: (Number(product.price) * item.quantity).toFixed(2), availability_message: '' };
    });
    return { cart_id: 5001, items: rows, total_quantity: rows.reduce((total, item) => total + item.quantity, 0), subtotal: rows.reduce((total, item) => total + Number(item.line_total), 0).toFixed(2) };
  };
  await page.route(`${API}/api/auth/**`, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/me') && expiredToken) return route.fulfill({ status: 401, headers: CORS_HEADERS, json: { success: false, message: 'Invalid or expired token' } });
    if (path.endsWith('/login')) expiredToken = false;
    if (path.endsWith('/register')) {
      registerBody = request.postDataJSON();
      return route.fulfill({ status: 201, headers: CORS_HEADERS, json: { success: true, user: { ...user, role: 'user' } } });
    }
    return route.fulfill({ headers: CORS_HEADERS, json: path.endsWith('/login') ? { success: true, token: 'cart-ui-test-token', token_type: 'Bearer', expires_in: 3600, user } : { success: true, user } });
  });
  await page.route(new RegExp(`${API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/cart(?:/[^?]*)?(?:\\?.*)?$`), async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    const path = new URL(request.url()).pathname;
    if (path === '/api/cart/preview') return route.continue();
    if (path === '/api/cart' && request.method() === 'GET') return route.fulfill({ headers: CORS_HEADERS, json: { success: true, cart: asCart() } });
    if (path === '/api/cart/items' && request.method() === 'POST') {
      const incoming = request.postDataJSON();
      const existing = items.find(item => item.product_id === incoming.product_id);
      if (existing) existing.quantity += incoming.quantity;
      else items.push({ product_id: incoming.product_id, quantity: incoming.quantity, selected: false });
      return route.fulfill({ headers: CORS_HEADERS, json: { success: true, cart: asCart() } });
    }
    if (path === '/api/cart/merge') {
      const incoming = request.postDataJSON().items;
      const key = request.headers()['idempotency-key'];
      mergeKeys.push(key);
      const fingerprint = JSON.stringify(incoming);
      if (committed.has(key)) {
        expect(committed.get(key)).toBe(fingerprint);
        if (holdMergeResponses) return route.abort('failed');
        return route.fulfill({ headers: CORS_HEADERS, json: { success: true, replayed: true, cart: asCart() } });
      }
      const conflicts = incoming.flatMap(item => {
        const product = products.find(product => product.product_id === item.product_id);
        const total = item.quantity + (items.find(existing => existing.product_id === item.product_id)?.quantity || 0);
        return total > product.stock_quantity ? [{ product_id: product.product_id, name: product.name, requested_quantity: total, stock_quantity: product.stock_quantity, status: product.status, reason: 'Quantity exceeds available stock' }] : [];
      });
      if (conflicts.length) return route.fulfill({ status: 409, headers: CORS_HEADERS, json: { success: false, message: 'Không thể hợp nhất giỏ hàng', conflicts } });
      items = items.map(item => ({ ...item, selected: false }));
      for (const item of incoming) {
        const existing = items.find(existing => existing.product_id === item.product_id);
        if (existing) { existing.quantity += item.quantity; existing.selected = Boolean(item.selected); }
        else items.push({ ...item });
      }
      committed.set(key, fingerprint);
      if (options.loseFirstMergeResponse && !firstResponseLost) {
        firstResponseLost = true;
        return route.abort('failed');
      }
      return route.fulfill({ headers: CORS_HEADERS, json: { success: true, replayed: false, cart: asCart() } });
    }
    if (path === '/api/cart/selection') {
      const selected = request.postDataJSON().product_ids;
      items = items.map(item => ({ ...item, selected: selected.includes(item.product_id) }));
      return route.fulfill({ headers: CORS_HEADERS, json: { success: true, cart: asCart() } });
    }
    const id = Number(path.split('/').at(-1));
    const item = items[id - 1001];
    if (request.method() === 'PUT' && item) item.quantity = request.postDataJSON().quantity;
    else if (request.method() === 'DELETE' && item) items = items.filter(existing => existing !== item);
    return route.fulfill({ headers: CORS_HEADERS, json: { success: true, cart: asCart() } });
  });
  return { user, mergeKeys, cart: asCart, getRegisterBody: () => registerBody, releaseMergeResponse: () => { holdMergeResponses = false; }, expireMe: () => { expiredToken = true; } };
}

test('đăng nhập từ Header về trang chủ và vẫn hợp nhất giỏ khách', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  const account = await mockAccount(page, products, [{ product_id: product.product_id, quantity: 2, selected: false }]);
  await addFromDetail(page, product, 3);
  await page.locator('.site-header .account-action').click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page.locator('.auth-intent-note')).toHaveCount(0);
  await login(page, /\/$/);
  await expect(page.locator('#hero-title')).toBeVisible();
  await expect(page.locator('.site-header .account-action')).toContainText(account.user.full_name);
  await expectCartBadge(page, 1);
  expect(account.cart().items[0].quantity).toBe(5);
  await page.reload();
  await expect(page.locator('#hero-title')).toBeVisible();
  await expect(page.locator('.site-header .account-action')).toContainText(account.user.full_name);
  await expectCartBadge(page, 1);
});

test('đăng nhập Header sau khi bỏ dở đặt hàng không dùng ý định cũ để chuyển về giỏ', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  await mockAccount(page, products);
  await addFromDetail(page, product, 2);
  await page.goto('/cart');
  await row(page, product).getByRole('checkbox').check();
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await page.goto('/');
  await page.locator('.site-header .account-action').click();
  await expect(page.locator('.auth-intent-note')).toHaveCount(0);
  await login(page, /\/$/);
  await expect(page.locator('#hero-title')).toBeVisible();
  await expect(page.locator('.feature-notice')).not.toContainText('Chức năng đặt hàng đang được hoàn thiện');
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue('2');
});

test('flow không khớp không khôi phục đặt hàng dù còn giỏ và ý định mua', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  await mockAccount(page, products);
  await addFromDetail(page, product, 2);
  await page.goto('/cart');
  await row(page, product).getByRole('checkbox').check();
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/login\?flow=/);
  await page.goto('/login?flow=unmatched-flow');
  await expect(page.locator('.auth-intent-note')).toHaveCount(0);
  await login(page, /\/$/);
  await expect(page.locator('#hero-title')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue('2');
});

for (const change of ['missing', 'replaced']) {
  test(`ý định ${change} không được dùng với flow đặt hàng cũ`, async ({ page, request }) => {
    const products = await catalog(request);
    const [product] = products;
    const account = await mockAccount(page, products);
    await addFromDetail(page, product, 2);
    await page.goto('/cart');
    await row(page, product).getByRole('checkbox').check();
    await page.locator('.cart-checkout').click();
    await expect(page).toHaveURL(/\/login\?flow=/);
    await page.evaluate(kind => {
      const key = 'petcare.checkout-intent.v1';
      // A valid tab-local draft now recovers the purchase independently of the
      // shared legacy intent. Invalidate both to exercise an abandoned flow.
      sessionStorage.removeItem('petcare.checkout-draft.v1');
      if (kind === 'missing') localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), id: 'replacement-intent' }));
    }, change);
    await login(page, /\/$/);
    await expect(page.locator('#hero-title')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
    expect(account.cart().items[0].quantity).toBe(2);
    await page.goto('/cart');
    await expect(rowQuantity(page, product)).toHaveValue('2');
  });
}

test('đăng ký thông thường giữ nguồn đăng nhập và đăng nhập về trang chủ', async ({ page, request }) => {
  const products = await catalog(request);
  await mockAccount(page, products);
  await page.goto('/');
  await page.locator('.site-header .account-action').click();
  await page.locator('.auth-switch').getByRole('link', { name: 'Đăng ký', exact: true }).click();
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill('Cart UI test');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('cart-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CartUiOnly123!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('CartUiOnly123!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page.locator('.auth-registration-notice')).toBeVisible();
  await expect(page.locator('.auth-intent-note')).toHaveCount(0);
  await login(page, /\/$/);
  await expect(page.locator('#hero-title')).toBeVisible();
});

test('returnTo nội bộ an toàn được giữ qua chuyển đăng ký và đăng nhập', async ({ page, request }) => {
  const products = await catalog(request);
  await mockAccount(page, products);
  const destination = '/products?q=SHED-X';
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.locator('.auth-switch').getByRole('link', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/register\?/);
  await page.locator('.auth-switch').getByRole('link', { name: 'Đăng nhập', exact: true }).click();
  await login(page, new RegExp(`${destination.replace('?', '\\?')}$`));
  await expect(page.getByRole('heading', { name: 'Danh sách sản phẩm', exact: true })).toBeVisible();
});

for (const destination of ['https://example.test/steal', '//example.test/steal', '/\\example.test/steal', '/%2f%2fexample.test/steal', '/login', '/register', '/missing-route']) {
  test(`returnTo không hợp lệ không chuyển ra ngoài hoặc quay lại form: ${destination}`, async ({ page, request }) => {
    const products = await catalog(request);
    await mockAccount(page, products);
    const externalRequests = [];
    await page.route('https://example.test/**', route => { externalRequests.push(route.request().url()); return route.abort(); });
    await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
    await login(page, /\/$/);
    await expect(page.locator('#hero-title')).toBeVisible();
    expect(externalRequests).toEqual([]);
  });
}

test('khách thêm trùng, chỉnh/xóa/chọn hàng và tải lại vẫn giữ giỏ, tính đúng tiền được chọn', async ({ page, request }, testInfo) => {
  const [first, second] = await catalog(request);
  await page.goto('/cart');
  await expect(page.locator('.cart-empty')).toBeVisible();
  await expectCartBadge(page, 0);
  await addFromDetail(page, first, 2);
  await expectCartBadge(page, 1);
  await addFromDetail(page, first, 1);
  await expectCartBadge(page, 1);
  await addFromDetail(page, second, 1);
  await expectCartBadge(page, 2);
  await page.goto('/cart');
  await expect(page.locator('.cart-row')).toHaveCount(2);
  await expect(rowQuantity(page, first)).toHaveValue('3');
  await row(page, first).getByRole('checkbox').check();
  await row(page, second).getByRole('checkbox').uncheck();
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (3 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 3));
  await expectCartBadge(page, 2);
  await page.reload();
  await expect(rowQuantity(page, first)).toHaveValue('3');
  await expect(row(page, first).getByRole('checkbox')).toBeChecked();
  await expect(row(page, second).getByRole('checkbox')).not.toBeChecked();
  await expectCartBadge(page, 2);
  await rowQuantity(page, first).fill('2');
  await rowQuantity(page, first).blur();
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (2 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 2));
  await expectCartBadge(page, 2);
  await page.getByRole('checkbox', { name: 'Chọn tất cả sản phẩm hợp lệ', exact: true }).check();
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 2 sản phẩm (3 món)');
  await expect(page.locator('.cart-checkout')).toContainText('Đặt hàng (2)');
  await row(page, second).getByRole('button', { name: `Xóa ${second.name}`, exact: true }).click();
  await expect(page.locator('.cart-row')).toHaveCount(1);
  await expectCartBadge(page, 1);
  await page.getByRole('checkbox', { name: 'Chọn tất cả sản phẩm hợp lệ', exact: true }).uncheck();
  await expect(page.locator('.cart-checkout')).toBeDisabled();
  await expectCartBadge(page, 1);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Giỏ hàng ở ${width}px`).toBe(true);
    await expectCartBadge(page, 1);
  }
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: testInfo.outputPath('cart-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('cart-mobile.png'), fullPage: true });
  await row(page, first).getByRole('button', { name: `Xóa ${first.name}`, exact: true }).click();
  await expect(page.locator('.cart-row')).toHaveCount(0);
  await expectCartBadge(page, 0);
  await expect(page.locator('.cart-empty').getByRole('link', { name: 'Tiếp tục mua sắm', exact: true })).toHaveAttribute('href', '/products');
});

test('badge giỏ tài khoản đếm loại sản phẩm, giữ nguyên khi thêm trùng/chỉnh số lượng/chọn hàng', async ({ page, request }) => {
  const products = await catalog(request);
  const [first, second] = products;
  const account = await mockAccount(page, products, [
    { product_id: first.product_id, quantity: 2, selected: true },
    { product_id: second.product_id, quantity: 1, selected: false },
  ]);
  await page.goto('/login');
  await login(page, /\/$/);
  await expectCartBadge(page, 2);
  await addFromDetail(page, first, 2);
  await expectCartBadge(page, 2);
  await page.goto('/cart');
  await expect(rowQuantity(page, first)).toHaveValue('4');
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (4 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 4));
  await rowQuantity(page, first).fill('5');
  await rowQuantity(page, first).blur();
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (5 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 5));
  await expectCartBadge(page, 2);
  await row(page, first).getByRole('checkbox').uncheck();
  await expect(page.locator('.cart-subtotal')).toHaveText(price(0));
  await expect(page.locator('.cart-checkout')).toBeDisabled();
  await expectCartBadge(page, 2);
  await row(page, first).getByRole('checkbox').check();
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 5));
  await expectCartBadge(page, 2);
  await row(page, second).getByRole('button', { name: `Xóa ${second.name}`, exact: true }).click();
  await expectCartBadge(page, 1);
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 5));
  await page.reload();
  await expect(rowQuantity(page, first)).toHaveValue('5');
  await expectCartBadge(page, 1);
  await row(page, first).getByRole('button', { name: `Xóa ${first.name}`, exact: true }).click();
  await expect(page.locator('.cart-empty')).toBeVisible();
  await expectCartBadge(page, 0);
  expect(account.cart().items).toEqual([]);
});

test('giỏ khách dùng giá mới từ API, giữ dòng hết hàng nhưng không cho chọn đặt hàng', async ({ page, request }) => {
  const [product] = await catalog(request);
  await addFromDetail(page, product, 2);
  await page.route(`${API}/api/cart/preview`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.cart.items) {
      item.price = '123456.00'; item.line_total = (123456 * item.quantity).toFixed(2);
      item.stock_quantity = 0; item.available = false; item.availability_message = 'Sản phẩm đã hết hàng';
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/cart');
  await expect(row(page, product)).toBeVisible();
  await expect(row(page, product)).toContainText(price(123456));
  await expect(row(page, product)).toContainText('hết hàng');
  await expect(row(page, product).getByRole('checkbox')).toBeDisabled();
  await expect(page.locator('.cart-checkout')).toBeDisabled();
  await expectCartBadge(page, 1);
  await row(page, product).getByRole('button', { name: `Xóa ${product.name}`, exact: true }).click();
  await expect(page.locator('.cart-row')).toHaveCount(0);
  await expectCartBadge(page, 0);
});

test('đăng ký/đăng nhập giữ giỏ và lựa chọn, hợp nhất chỉ chọn hàng khách đã chọn', async ({ page, request }) => {
  const products = await catalog(request);
  const [first, accountOnly, guestOnly] = products;
  const account = await mockAccount(page, products, [{ product_id: first.product_id, quantity: 2, selected: true }, { product_id: accountOnly.product_id, quantity: 1, selected: true }]);
  await addFromDetail(page, first, 3);
  await addFromDetail(page, guestOnly, 1);
  await page.goto('/cart');
  await row(page, first).getByRole('checkbox').check();
  await row(page, guestOnly).getByRole('checkbox').uncheck();
  await expectCartBadge(page, 2);
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  const flow = new URL(page.url()).searchParams.get('flow');
  expect(flow).toBeTruthy();
  const intent = await page.evaluate(() => JSON.parse(localStorage.getItem('petcare.checkout-intent.v1')));
  expect(intent.type).toBe('cart');
  expect(intent.product_ids).toEqual([first.product_id]);
  expect(intent.items).toEqual([{ product_id: first.product_id, quantity: 3 }]);
  await page.locator('.auth-page').getByRole('link', { name: /Đăng ký/ }).click();
  await expect(page).toHaveURL(/\/register(?:\?.*)?$/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(flow);
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill('Cart UI test');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('cart-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CartUiOnly123!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('CartUiOnly123!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(flow);
  expect(account.getRegisterBody()).not.toHaveProperty('role');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('petcare.checkout-intent.v1')).product_ids)).toEqual([first.product_id]);
  await login(page);
  await expect(page.locator('.checkout-item')).toHaveCount(1);
  await expect(page.locator(`.checkout-item[data-product-id="${first.product_id}"]`)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('petcare.checkout-draft.v1')).items)).toEqual([{ product_id: first.product_id, quantity: 3 }]);
  await page.goto('/cart');
  await expect(rowQuantity(page, first)).toHaveValue('5');
  await expect(rowQuantity(page, accountOnly)).toHaveValue('1');
  await expect(rowQuantity(page, guestOnly)).toHaveValue('1');
  await expect(row(page, first).getByRole('checkbox')).toBeChecked();
  await expect(row(page, accountOnly).getByRole('checkbox')).not.toBeChecked();
  await expect(row(page, guestOnly).getByRole('checkbox')).not.toBeChecked();
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (5 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 5));
  await expectCartBadge(page, 3);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
  await page.reload();
  await expectCartBadge(page, 3);
  await expect(page.locator('.cart-selection-summary')).toContainText('Đã chọn 1 sản phẩm (5 món)');
  await expect(page.locator('.cart-subtotal')).toHaveText(price(Number(first.price) * 5));
});

test('xung đột hợp nhất giữ giỏ khách, chặn đặt hàng và cho điều chỉnh rồi thử lại', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  const account = await mockAccount(page, products, [{ product_id: product.product_id, quantity: Number(product.stock_quantity) - 1, selected: false }]);
  await addFromDetail(page, product, 3);
  await page.goto('/cart');
  await row(page, product).getByRole('checkbox').check();
  await page.locator('.cart-checkout').click();
  await login(page, /\/cart(?:\?.*)?$/);
  await expect(page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true })).toBeVisible();
  await expect(page.locator('.cart-page')).toContainText(product.name);
  await expect(page.locator('.cart-checkout')).toBeDisabled();
  expect(account.cart().items[0].quantity).toBe(Number(product.stock_quantity) - 1);
  await expect(rowQuantity(page, product)).toHaveValue('3');
  await rowQuantity(page, product).fill('1');
  await rowQuantity(page, product).blur();
  await page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true }).click();
  await expect(page).toHaveURL(/\/checkout(?:\?.*)?$/);
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue(String(product.stock_quantity));
  await expect(page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true })).toHaveCount(0);
});

test('mất phản hồi sau hợp nhất: tải lại/thử lại giữ cùng khóa và không cộng hàng hai lần', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  const account = await mockAccount(page, products, [{ product_id: product.product_id, quantity: 2, selected: false }], { loseFirstMergeResponse: true });
  await addFromDetail(page, product, 3);
  await page.goto('/cart');
  await row(page, product).getByRole('checkbox').check();
  await page.locator('.cart-checkout').click();
  await login(page, /\/cart(?:\?.*)?$/);
  await expect(page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true })).toBeVisible();
  await expect(page.locator('.cart-checkout')).toBeDisabled();
  const pending = await page.evaluate(() => ({ guest: JSON.parse(localStorage.getItem('petcare.guest-cart.v1')), merge: JSON.parse(localStorage.getItem('petcare.guest-merge.v1')) }));
  expect(pending.guest.items[0].quantity).toBe(3);
  expect(pending.merge.key).toBeTruthy();
  account.releaseMergeResponse();
  await page.reload();
  await expect(page).toHaveURL(/\/checkout(?:\?.*)?$/);
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue('5');
  expect(account.cart().items[0].quantity).toBe(5);
  expect(account.mergeKeys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(account.mergeKeys).size).toBe(1);
});

for (const reason of ['missing-token', 'expired-token']) {
  test(`hợp nhất đang chờ ${reason}: đăng nhập lại giữ flow và không cộng giỏ hai lần`, async ({ page, request }) => {
    const products = await catalog(request);
    const [product] = products;
    const account = await mockAccount(page, products, [{ product_id: product.product_id, quantity: 2, selected: false }], { loseFirstMergeResponse: true });
    await addFromDetail(page, product, 3);
    await page.goto('/cart');
    await row(page, product).getByRole('checkbox').check();
    await page.locator('.cart-checkout').click();
    await expect(page).toHaveURL(/\/login\?flow=/);
    const flow = new URL(page.url()).searchParams.get('flow');
    await login(page, /\/cart(?:\?.*)?$/);
    await expect(page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true })).toBeVisible();
    if (reason === 'missing-token') await page.evaluate(() => sessionStorage.removeItem('petcare.auth.token.v1'));
    else account.expireMe();
    await page.reload();
    await expect(page.locator('.site-header .account-action')).toContainText('Đăng nhập / Đăng ký');
    await page.getByRole('button', { name: 'Thử đồng bộ lại', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?flow=/);
    expect(new URL(page.url()).searchParams.get('flow')).toBe(flow);
    account.releaseMergeResponse();
    await login(page);
    await expect(page.locator('.checkout-page')).toBeVisible();
    await page.goto('/cart');
    await expect(rowQuantity(page, product)).toHaveValue('5');
    await expect(row(page, product).getByRole('checkbox')).toBeChecked();
    expect(account.cart().items[0].quantity).toBe(5);
    expect(new Set(account.mergeKeys).size).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
  });
}

test('đăng xuất bỏ trạng thái giỏ tài khoản nhưng không đổi dữ liệu tài khoản thành giỏ khách', async ({ page, request }) => {
  const products = await catalog(request);
  const [product] = products;
  const account = await mockAccount(page, products, [{ product_id: product.product_id, quantity: 4, selected: true }]);
  await page.goto('/login');
  await login(page, /\/$/);
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue('4');
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/checkout(?:\?.*)?$/);
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('petcare.checkout-intent.v1'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
  await page.goto('/cart');
  await expect(page.locator('.cart-row')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.cart-row')).toHaveCount(0);
  expect(account.cart().items[0].quantity).toBe(4);
  await page.locator('.site-header .account-action').click();
  await login(page, /\/$/);
  await expect(page.locator('#hero-title')).toBeVisible();
  await page.goto('/cart');
  await expect(rowQuantity(page, product)).toHaveValue('4');
});

test('Mua ngay lưu ý định riêng, đi qua đăng ký/đăng nhập và không thay giỏ hoặc tạo đơn', async ({ page, request }) => {
  const products = await catalog(request);
  const [cartProduct, buyProduct] = products;
  const account = await mockAccount(page, products, []);
  const orderRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/orders')) orderRequests.push(request.url()); });
  await addFromDetail(page, cartProduct, 2);
  await page.goto(`/products/${buyProduct.product_id}`);
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill('3');
  await page.locator('.detail-actions .buy-now').click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  const intent = await page.evaluate(() => JSON.parse(localStorage.getItem('petcare.checkout-intent.v1')));
  expect(intent.type).toBe('buy-now');
  expect(intent.items).toEqual([{ product_id: buyProduct.product_id, quantity: 3 }]);
  await page.locator('.auth-page').getByRole('link', { name: /Đăng ký/ }).click();
  await page.locator('.auth-page').getByRole('link', { name: /Đăng nhập/ }).click();
  await login(page);
  await expect(page.locator(`.checkout-item[data-product-id="${buyProduct.product_id}"]`)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('petcare.checkout-draft.v1')).items)).toEqual([{ product_id: buyProduct.product_id, quantity: 3 }]);
  await page.goto('/cart');
  await expect(rowQuantity(page, cartProduct)).toHaveValue('2');
  await expect(row(page, buyProduct)).toHaveCount(0);
  expect(account.cart().items).toHaveLength(1);
  const completedIntent = await page.evaluate(() => JSON.parse(localStorage.getItem('petcare.checkout-intent.v1')));
  expect(completedIntent.items).toEqual([{ product_id: buyProduct.product_id, quantity: 3 }]);
  expect(orderRequests).toEqual([]);
});

test('đăng nhập Admin dùng cùng form nhưng không tải hoặc thao tác giỏ User', async ({ page, request }) => {
  const products = await catalog(request);
  await mockAccount(page, products, [], { role: 'admin' });
  await page.route(`${API}/api/admin/orders*`, route => route.request().method() === 'GET'
    ? route.fulfill({ headers: CORS_HEADERS, json: { success: true, page: 1, limit: 20, total: 0, orders: [] } })
    : route.abort());
  const accountCartRequests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/cart') && path !== '/api/cart/preview') accountCartRequests.push(path);
  });
  await addFromDetail(page, products[0], 2);
  await page.locator('.site-header .account-action').click();
  await login(page, /\/admin\/orders$/);
  await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible();
  await expect(page.locator('.site-header .account-action')).toContainText('Quản trị viên');
  await page.goto('/cart');
  await expect(page.locator('.cart-page')).toContainText(/Admin|quản trị/i);
  await expect(page.locator('.cart-row')).toHaveCount(0);
  expect(accountCartRequests).toEqual([]);
  const guest = await page.evaluate(() => JSON.parse(localStorage.getItem('petcare.guest-cart.v1')));
  expect(guest.items[0].quantity).toBe(2);
});

async function mockRoleLogin(page) {
  const accounts = {
    admin: { user_id: 950001, full_name: 'Admin điều hướng', email: 'navigation-admin@example.test', role: 'admin', status: 'active' },
    user: { user_id: 950002, full_name: 'Khách hàng điều hướng', email: 'navigation-user@example.test', role: 'user', status: 'active' },
  };
  const emptyCart = { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00', selected_subtotal: '0.00' };
  const unexpected = [], adminReads = [];
  await page.route(`${API}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, headers: CORS_HEADERS, json: { success: status === 200, ...body } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    if (['/api/products', '/api/categories', '/api/cart/preview'].includes(path)) return route.continue();
    if (path === '/api/vouchers/readiness' && method === 'GET') return json({ readiness: { ready: false, online_ready: false } });
    const actor = Object.keys(accounts).find(key => request.headers().authorization === `Bearer auth-navigation-${key}`);
    if (path === '/api/auth/me' && method === 'GET') return actor ? json({ user: accounts[actor] }) : json({ message: 'Invalid or expired token' }, 401);
    if (path === '/api/auth/login' && method === 'POST') {
      const input = request.postDataJSON();
      const selected = Object.keys(accounts).find(key => accounts[key].email === input.email);
      if (!selected || input.password === 'invalid') return json({ message: 'Invalid email or password' }, 401);
      return json({ token: `auth-navigation-${selected}`, user: accounts[selected] });
    }
    if (path === '/api/cart' && method === 'GET' && actor === 'user') return json({ cart: emptyCart });
    if (path.startsWith('/api/admin/') && method === 'GET' && actor === 'admin') {
      adminReads.push(path);
      return json({ page: 1, limit: 20, total: 0, orders: [], products: [], categories: [], users: [], vouchers: [] });
    }
    unexpected.push({ path, method, actor });
    return route.abort();
  });
  const signIn = async (actor, destination, password = 'Synthetic-login-only!') => {
    await page.getByLabel('Email', { exact: true }).fill(accounts[actor].email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    if (destination) await expect(page).toHaveURL(destination);
  };
  const signOut = async () => {
    await page.locator('.account-trigger').click();
    await page.locator('.account-menu-logout').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeNull();
  };
  return { signIn, signOut, unexpected, adminReads };
}

test('auth-navigation: User về Trang chủ khi returnTo trỏ tới bất kỳ trang Admin nào', async ({ page }) => {
  const account = await mockRoleLogin(page);
  for (const destination of ['/admin/orders', '/admin/orders/801', '/admin/products?q=pet', '/admin/categories', '/admin/users', '/admin/vouchers']) {
    await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
    await account.signIn('user', /\/$/);
    await expect(page.locator('#hero-title')).toBeVisible();
    await expect(page.locator('.account-trigger')).toContainText('Khách hàng điều hướng');
    await account.signOut();
  }
  expect(account.adminReads).toEqual([]);
  expect(account.unexpected).toEqual([]);
});

test('auth-navigation: Admin giữ trang quản trị hợp lệ, mặc định về quản lý đơn hàng', async ({ page }) => {
  const account = await mockRoleLogin(page);
  await page.goto('/login');
  await account.signIn('admin', /\/admin\/orders$/);
  await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible();
  await account.signOut();
  await page.goto('/login?returnTo=%2Fadmin%2Fproducts%3Fq%3Dpet');
  await account.signIn('admin', /\/admin\/products\?q=pet$/);
  await expect(page.locator('.account-trigger')).toContainText('Quản trị viên');
  expect(account.unexpected).toEqual([]);
});

test('auth-navigation: chuyển Admin → User → Admin không giữ đường dẫn cũ, thông báo có tích xanh và animation', async ({ page }) => {
  const account = await mockRoleLogin(page);
  await page.goto('/admin/orders');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await account.signIn('admin', /\/admin\/orders$/);
  await account.signOut();
  await account.signIn('user', /\/$/);
  const notice = page.locator('.feature-notice');
  await expect(notice).toContainText('Đã đăng nhập.');
  await expect(notice.locator('.feature-notice-icon')).toHaveCSS('color', 'rgb(36, 134, 95)');
  await expect(notice).toHaveCSS('animation-name', 'notice-enter');
  await expect(page.locator('#main-content')).toHaveCSS('animation-name', 'page-enter');
  await notice.getByRole('button', { name: 'Đóng thông báo' }).click();
  await expect(notice).toHaveClass(/is-leaving/);
  await expect(notice).toHaveCount(0);
  await account.signOut();
  await account.signIn('admin', /\/admin\/orders$/);
  await expect(page.locator('.feature-notice--success .feature-notice-icon')).toBeVisible();
  expect(account.unexpected).toEqual([]);
});

test('auth-navigation: giữ returnTo công khai và tôn trọng giảm chuyển động', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const account = await mockRoleLogin(page);
  await page.goto('/login?returnTo=%2Fproducts%3Fq%3Dpet');
  await account.signIn('user', /\/products\?q=pet$/);
  const notice = page.locator('.feature-notice--success');
  await expect(notice.locator('.feature-notice-icon')).toBeVisible();
  await expect(notice).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#main-content')).toHaveCSS('animation-name', 'none');
  await notice.getByRole('button', { name: 'Đóng thông báo' }).click();
  await expect(notice).toHaveCount(0);
  expect(account.unexpected).toEqual([]);
});

test('auth-navigation: đăng nhập thất bại giữ nguyên trang và không hiện thành công', async ({ page }) => {
  const account = await mockRoleLogin(page);
  await page.goto('/login?returnTo=%2Fadmin%2Forders');
  await account.signIn('user', null, 'invalid');
  await expect(page.locator('.commerce-action-error')).toContainText('Email hoặc mật khẩu không đúng.');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.locator('.feature-notice--success')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeNull();
  expect(account.unexpected).toEqual([]);
});
