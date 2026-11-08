import { test, expect } from '@playwright/test';

const currency = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 }).format(Number(value));
const picker = page => page.getByRole('dialog', { name: 'Chọn Voucher cho đơn hàng', exact: true });
const opener = page => page.getByRole('button', { name: 'Chọn Voucher', exact: true });
const choose = (page, code) => picker(page).getByRole('button', { name: `Chọn Voucher ${code}`, exact: true });
const close = page => picker(page).getByRole('button', { name: 'Đóng danh sách Voucher', exact: true });
const submit = page => page.locator('.checkout-submit');
const term = (code, overrides = {}) => ({ code, discount_type: 'percent', discount_value: '10.00', max_discount_amount: '30000.00', minimum_order_amount: '0.00',
  starts_at_utc: '2026-01-01T00:00:00.000Z', ends_at_utc: '2027-12-31T00:00:00.000Z', ...overrides });

// All HTTP API traffic is intercepted; this suite never starts the backend or
// connects to MySQL. Requests outside the deliberately small fixture are blocked.
async function fixture(page, { ready = true, onlineReady = true } = {}) {
  const user = { user_id: 990002, role: 'user', status: 'active', full_name: 'Khách chọn Voucher', email: 'voucher-picker@example.test', phone: '0900000000', address: '123 Đường Kiểm Thử' };
  const product = { product_id: 1, category_id: 1, name: 'Thức ăn kiểm thử chọn Voucher', description: '', price: '100000.00', stock_quantity: 100, status: 'Đang bán', image_url: '/images/products/test.webp' };
  const terms = [term('SAVE10'), term('SAVE20', { discount_type: 'fixed', discount_value: '20000.00', max_discount_amount: null }),
    term('HIGH_MIN', { minimum_order_amount: '300000.00' })];
  const lists = [], quotes = [], orders = [], unexpected = [];
  let listHandler = null, quoteHandler = null;
  const quoted = code => ({ voucher: { ...terms[0], code }, subtotal_amount: '200000.00', discount_amount: code === 'SAVE20' ? '70000.00' : '53210.88',
    total_amount: code === 'SAVE20' ? '130000.00' : '146789.12', quota: { remaining_total: 1, remaining_user: 1 }, reserved: false });
  await page.addInitScript(({ user }) => {
    sessionStorage.setItem('petcare.auth.token.v1', 'voucher-picker-synthetic-token');
    sessionStorage.setItem('petcare.checkout-draft.v1', JSON.stringify({ version: 1, intent_id: 'voucher-picker-synthetic-checkout', type: 'buy-now', user_id: user.user_id,
      items: [{ product_id: 1, quantity: 2 }], prices: { 1: '100000.00' }, shipping: { recipient_name: user.full_name, phone: user.phone, address: user.address, note: '' },
      payment_method: 'COD', submission: null, order: null }));
  }, { user });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };
    const json = (body, status = 200) => route.fulfill({ status, headers, json: { success: true, ...body } });
    const reject = (code, message, status = 409) => route.fulfill({ status, headers, json: { success: false, code, message } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/api/vouchers/readiness' && method === 'GET') return json({ readiness: { ready, online_ready: ready && onlineReady } });
    if (path === '/api/products' && method === 'GET') return json({ products: [product] });
    if (path === '/api/categories' && method === 'GET') return json({ categories: [{ category_id: 1, name: 'Thức ăn', description: '' }] });
    if (path === '/api/auth/me' && method === 'GET') return json({ user });
    if (path === '/api/cart' && method === 'GET') return json({ cart: { cart_id: null, items: [], subtotal: '0.00', selected_subtotal: '0.00', total_quantity: 0, selected_quantity: 0, selected_count: 0 } });
    if (path === '/api/cart/preview' && method === 'POST') return json({ cart: { items: request.postDataJSON().items.map(item => ({ ...product, ...item, available: true, availability_message: '' })) } });
    if (path === '/api/vouchers' && method === 'GET') {
      const pageNumber = Number(url.searchParams.get('page')), limit = Number(url.searchParams.get('limit'));
      const call = { page: pageNumber, limit, authorization: request.headers().authorization };
      lists.push(call);
      if (listHandler) return listHandler({ route, call, json, reject });
      return json({ page: pageNumber, limit, total: terms.length, vouchers: terms });
    }
    if (path === '/api/vouchers/quote' && method === 'POST') {
      const body = request.postDataJSON(); quotes.push(body);
      if (quoteHandler) return quoteHandler({ body, json, reject });
      return json({ quote: quoted(body.code) });
    }
    if (path === '/api/orders' && method === 'POST') {
      const body = request.postDataJSON(); orders.push({ body, key: request.headers()['idempotency-key'] });
      const quote = body.voucher_code ? quoted(body.voucher_code) : null;
      return json({ replayed: false, order: { order_id: 8811, user_id: user.user_id, ...body, total_amount: quote?.total_amount || '200000.00', payment_amount: quote?.total_amount || '200000.00',
        subtotal_amount: quote?.subtotal_amount ?? null, discount_amount: quote?.discount_amount ?? null, voucher_code_snapshot: body.voucher_code ?? null,
        status: 'Chờ xử lý', payment_status: 'Chưa thanh toán', approved_at: null,
        items: [{ ...product, quantity: 2, unit_price: product.price, subtotal: '200000.00' }] } }, 201);
    }
    unexpected.push({ path, method }); return route.abort('blockedbyclient');
  });
  await page.goto('/checkout');
  await expect(submit(page)).toBeEnabled();
  return { terms, lists, quotes, orders, unexpected, onList: handler => { listHandler = handler; }, onQuote: handler => { quoteHandler = handler; } };
}

test('Chọn Voucher ẩn khi readiness tắt và không gọi API danh sách', async ({ page }) => {
  const mocked = await fixture(page, { ready: false });
  await expect(opener(page)).toHaveCount(0);
  expect(mocked.lists).toEqual([]);
  expect(mocked.quotes).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Voucher Online chưa sẵn sàng vô hiệu hóa nút chọn và không tải danh sách', async ({ page }) => {
  const mocked = await fixture(page, { onlineReady: false });
  await expect(opener(page)).toBeEnabled();
  await page.getByRole('radio', { name: /Thanh toán online/i }).check();
  await expect(opener(page)).toBeDisabled();
  expect(mocked.lists).toEqual([]);
  expect(mocked.quotes).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Danh sách công khai hiển thị điều kiện; mã chưa đạt đơn tối thiểu không được chọn', async ({ page }, testInfo) => {
  const mocked = await fixture(page);
  expect(mocked.lists).toEqual([]);
  await expect(opener(page)).toBeVisible();
  const inputBounds = await page.getByRole('textbox', { name: 'Mã Voucher', exact: true }).boundingBox();
  const chooseBounds = await opener(page).boundingBox();
  expect(Math.abs(inputBounds.y - chooseBounds.y)).toBeLessThan(1);
  await opener(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('[data-voucher-code="SAVE10"]')).toContainText('10');
  await expect(picker(page).locator('[data-voucher-code="SAVE20"]')).toContainText(currency('20000.00'));
  const high = picker(page).locator('[data-voucher-code="HIGH_MIN"]');
  await expect(high).toContainText(currency('300000.00'));
  await expect(high).toContainText('Chưa đạt đơn tối thiểu');
  await expect(choose(page, 'HIGH_MIN')).toBeDisabled();
  await expect(picker(page).locator('[data-voucher-code="SAVE10"] time')).toHaveAttribute('datetime', '2027-12-31T00:00:00.000Z');
  await page.screenshot({ path: testInfo.outputPath('voucher-picker-desktop.png'), fullPage: true });
  expect(mocked.lists[0]).toMatchObject({ page: 1, limit: 20, authorization: 'Bearer voucher-picker-synthetic-token' });
  expect(mocked.quotes).toEqual([]);
  expect(mocked.orders).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Chọn, thay và bỏ mã dùng quote hiện có; checkout chỉ gửi một voucher_code', async ({ page }) => {
  const mocked = await fixture(page);
  await opener(page).click(); await choose(page, 'SAVE10').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('.checkout-total')).toHaveText(currency('146789.12'));
  expect(mocked.quotes.at(-1)).toEqual({ code: 'SAVE10', items: [{ product_id: 1, quantity: 2 }], payment_method: 'COD' });
  await opener(page).click(); await choose(page, 'SAVE20').click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('130000.00'));
  await page.getByRole('button', { name: 'Bỏ Voucher', exact: true }).click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('200000.00'));
  await opener(page).click(); await choose(page, 'SAVE10').click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('146789.12'));
  await submit(page).click();
  await expect(page.locator('.checkout-confirmation')).toContainText('8811');
  expect(mocked.orders).toHaveLength(1);
  expect(mocked.orders[0].body.voucher_code).toBe('SAVE10');
  expect(Object.keys(mocked.orders[0].body).filter(key => /discount|amount|price/.test(key))).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Đổi mã bằng picker sau khi đổi phương thức không hủy nhầm quote mới hoặc kẹt giao diện', async ({ page }) => {
  const mocked = await fixture(page);
  await opener(page).click(); await choose(page, 'SAVE10').click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('146789.12'));
  await page.getByRole('radio', { name: /Thanh toán online/i }).check();
  await expect.poll(() => mocked.quotes.some(body => body.code === 'SAVE10' && body.payment_method === 'ONLINE')).toBe(true);
  await expect(opener(page)).toBeEnabled();
  await expect(page.locator('.checkout-total')).toHaveText(currency('146789.12'));
  await opener(page).click(); await choose(page, 'SAVE20').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('.checkout-total')).toHaveText(currency('130000.00'));
  await expect(page.getByRole('textbox', { name: 'Mã Voucher', exact: true })).toHaveValue('SAVE20');
  await expect(page.locator('.checkout-voucher-applied strong')).toHaveText('SAVE20');
  await expect(opener(page)).toBeEnabled();
  expect(mocked.quotes.at(-1)).toEqual({ code: 'SAVE20', items: [{ product_id: 1, quantity: 2 }], payment_method: 'ONLINE' });
  expect(mocked.orders).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Danh sách có loading, lỗi thử lại và trạng thái trống không dựng Voucher', async ({ page }) => {
  const mocked = await fixture(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  mocked.onList(async ({ reject }) => { await held; return reject('LIST_UNAVAILABLE', 'Chưa tải được danh sách Voucher.', 503); });
  await opener(page).click();
  await expect(picker(page).getByRole('status').filter({ hasText: /đang tải/i })).toBeVisible();
  release();
  await expect(picker(page).getByRole('alert')).toBeVisible();
  mocked.onList(({ call, json }) => json({ page: call.page, limit: call.limit, total: 0, vouchers: [] }));
  await picker(page).getByRole('button', { name: /Thử lại/i }).click();
  await expect(picker(page)).toContainText(/chưa có|không có/i);
  await expect(picker(page).locator('[data-voucher-code]')).toHaveCount(0);
  expect(mocked.quotes).toEqual([]);
  expect(mocked.orders).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Voucher vừa hết lượt hoặc hết hạn vẫn phải qua quote và không tạo đơn', async ({ page }) => {
  const mocked = await fixture(page);
  mocked.onQuote(({ reject }) => reject('VOUCHER_QUOTA_EXCEEDED', 'Mã Voucher đã hết lượt sử dụng.'));
  await opener(page).click(); await choose(page, 'SAVE10').click();
  await expect(page.getByRole('alert').filter({ hasText: /hết lượt/i })).toBeVisible();
  mocked.onQuote(({ reject }) => reject('VOUCHER_EXPIRED', 'Mã Voucher đã hết hạn.'));
  await opener(page).click(); await choose(page, 'SAVE20').click();
  await expect(page.getByRole('alert').filter({ hasText: /hết hạn/i })).toBeVisible();
  expect(mocked.orders).toEqual([]);
  expect(mocked.quotes.map(body => body.code)).toEqual(['SAVE10', 'SAVE20']);
  expect(mocked.unexpected).toEqual([]);
});

test('Phân trang và đóng danh sách bỏ qua phản hồi cũ, không tự áp mã', async ({ page }) => {
  const mocked = await fixture(page);
  mocked.onList(({ call, json }) => json({ page: call.page, limit: call.limit, total: 21, vouchers: [mocked.terms[call.page === 1 ? 0 : 1]] }));
  await opener(page).click();
  await expect(choose(page, 'SAVE10')).toBeVisible();
  await picker(page).getByRole('button', { name: /Trang sau/i }).click();
  await expect(choose(page, 'SAVE20')).toBeVisible();
  expect(mocked.lists.at(-1).page).toBe(2);
  await close(page).click();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  mocked.onList(async ({ call, json }) => { await held; try { await json({ page: call.page, limit: call.limit, total: 1, vouchers: [mocked.terms[0]] }); } catch { /* The closed dialog cancels its request. */ } });
  await opener(page).click();
  await expect(picker(page).getByRole('status').filter({ hasText: /đang tải/i })).toBeVisible();
  await close(page).click(); release();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('.checkout-total')).toHaveText(currency('200000.00'));
  expect(mocked.quotes).toEqual([]);
  expect(mocked.orders).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Mobile hộp chọn Voucher nằm trong khung nhìn và đóng bằng Escape', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mocked = await fixture(page);
  await opener(page).click();
  await expect(choose(page, 'SAVE10')).toBeVisible();
  expect(await picker(page).evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= window.innerWidth; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('voucher-picker-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  expect(mocked.quotes).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});
