import { test, expect } from '@playwright/test';

const currency = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 }).format(Number(value));
const codeInput = page => page.getByRole('textbox', { name: 'Mã Voucher', exact: true });
const apply = page => page.getByRole('button', { name: 'Áp dụng', exact: true });
const submit = page => page.locator('.checkout-submit');
const dialog = page => page.getByRole('dialog');
const voucherRow = (page, id = '1') => page.locator(`[data-voucher-id="${id}"]`);

async function fixture(page, { role = 'user', ready = true, onlineReady = true, readinessError = false, checkout = true, authenticated = true } = {}) {
  const user = { user_id: 990001, full_name: 'Khách Voucher kiểm thử', email: 'voucher-ui@example.test', role, status: 'active', phone: '0900000000', address: '123 Đường Kiểm Thử' };
  const catalog = [{ product_id: 1, category_id: 1, category_name: 'Thức ăn', name: 'Thức ăn Voucher giả lập', description: 'Dữ liệu kiểm thử', price: '100000.00', stock_quantity: 100, image_url: '/images/products/test.webp', status: 'Đang bán' }];
  const rows = [{ voucher_id: '1', code: 'SAVE10', discount_type: 'percent', discount_value: '10.00', minimum_order_amount: '0.00', max_discount_amount: '30000.00', starts_at_utc: '2026-01-01T00:00:00.000Z', ends_at_utc: '2027-12-31T00:00:00.000Z', total_limit: 100, per_user_limit: 2, status: 'active', created_at_utc: '2026-01-01T00:00:00.000Z', updated_at_utc: '2026-01-01T00:00:00.000Z' }];
  const reads = [], writes = [], quotes = [], orders = [], unexpected = [];
  const committed = new Map();
  let currentReady = ready, currentOnlineReady = onlineReady, failReadiness = readinessError;
  let quoteHandler = null, loseOrder = false, orderError = null;
  const gross = items => items.reduce((sum, item) => sum + Number(catalog.find(product => product.product_id === item.product_id)?.price || 0) * item.quantity, 0).toFixed(2);
  const quoted = body => {
    const total = body.code.toUpperCase() === 'FREE' ? '0.00' : '123456.78';
    return { voucher: { ...rows[0], code: body.code.toUpperCase() }, subtotal_amount: gross(body.items), discount_amount: (Number(gross(body.items)) - Number(total)).toFixed(2), total_amount: total, reserved: false, quota: { remaining_total: 99, remaining_user: 1 } };
  };
  await page.addInitScript(({ user, checkout, authenticated }) => {
    if (sessionStorage.getItem('voucher-ui-seeded')) return;
    sessionStorage.setItem('voucher-ui-seeded', '1');
    if (authenticated) sessionStorage.setItem('petcare.auth.token.v1', 'voucher-browser-fixture-token');
    if (checkout) sessionStorage.setItem('petcare.checkout-draft.v1', JSON.stringify({ version: 1, intent_id: 'voucher-fixture-intent', type: 'buy-now', user_id: user.user_id,
      items: [{ product_id: 1, quantity: 2 }], shipping: { recipient_name: user.full_name, phone: user.phone, address: user.address, note: '' },
      payment_method: 'COD', prices: { 1: '100000.00' }, submission: null, order: null }));
  }, { user, checkout, authenticated });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key' };
    const json = (body, status = 200) => route.fulfill({ status, headers, json: { success: true, ...body } });
    const reject = (code, message, status = 409) => route.fulfill({ status, headers, json: { success: false, code, message } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (method === 'GET') reads.push({ path, url: request.url() });
    else writes.push({ path, method, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    if (path === '/api/vouchers/readiness' && method === 'GET') return failReadiness ? reject('UNAVAILABLE', 'Readiness temporarily unavailable', 503) : json({ readiness: { ready: currentReady, online_ready: currentReady && currentOnlineReady } });
    if (path === '/api/products' && method === 'GET') return json({ products: catalog });
    if (path === '/api/categories' && method === 'GET') return json({ categories: [{ category_id: 1, name: 'Thức ăn', description: '' }] });
    if (path === '/api/auth/me' && method === 'GET') return json({ user });
    if (path === '/api/auth/login' && method === 'POST') return json({ user, token: 'voucher-browser-fixture-token', token_type: 'Bearer', expires_in: 3600 });
    if (path === '/api/cart' && method === 'GET') return json({ cart: { cart_id: null, items: [], subtotal: '0.00', selected_subtotal: '0.00', total_quantity: 0, selected_quantity: 0, selected_count: 0 } });
    if (path === '/api/cart/preview' && method === 'POST') {
      const items = request.postDataJSON().items;
      return json({ cart: { items: items.map(item => ({ ...catalog.find(product => product.product_id === item.product_id), ...item, available: true, availability_message: '' })) } });
    }
    if (path === '/api/vouchers/quote' && method === 'POST') {
      const body = request.postDataJSON(); quotes.push(body);
      if (quoteHandler) return quoteHandler({ route, body, json, reject, quoted });
      return json({ quote: quoted(body) });
    }
    if (path === '/api/orders' && method === 'POST') {
      const body = request.postDataJSON(), key = request.headers()['idempotency-key'];
      if (orderError) { const failure = orderError; orderError = null; return reject(failure.code, failure.message); }
      if (committed.has(key)) {
        const previous = committed.get(key);
        if (JSON.stringify(previous.body) !== JSON.stringify(body)) return reject('IDEMPOTENCY_CONFLICT', 'Payload changed');
        return json({ order: previous.order, replayed: true });
      }
      const quote = body.voucher_code ? quoted({ ...body, code: body.voucher_code }) : null;
      const order = { order_id: 8801, user_id: user.user_id, ...body, total_amount: quote?.total_amount || gross(body.items), payment_amount: quote?.total_amount || gross(body.items),
        subtotal_amount: quote?.subtotal_amount ?? null, discount_amount: quote?.discount_amount ?? null, voucher_code_snapshot: body.voucher_code ?? null,
        status: body.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán', payment_status: 'Chưa thanh toán', approved_at: null,
        items: body.items.map(item => ({ ...catalog[0], ...item, unit_price: catalog[0].price, subtotal: (Number(catalog[0].price) * item.quantity).toFixed(2) })) };
      committed.set(key, { body, order }); orders.push(order);
      if (loseOrder) { loseOrder = false; return route.abort('failed'); }
      return json({ order, replayed: false }, 201);
    }
    if (path === '/api/admin/vouchers') {
      if (method === 'GET') {
        const query = new URL(request.url()).searchParams;
        const filtered = rows.filter(row => (!query.get('q') || row.code.includes(query.get('q').toUpperCase())) && (!query.get('status') || row.status === query.get('status')));
        return json({ vouchers: filtered, total: filtered.length });
      }
      if (method === 'POST') {
        const voucher = { ...rows[0], ...request.postDataJSON(), voucher_id: String(rows.length + 1) };
        rows.push(voucher); return json({ voucher }, 201);
      }
    }
    const admin = path.match(/^\/api\/admin\/vouchers\/(\d+)(\/disable)?$/);
    if (admin) {
      const voucher = rows.find(row => row.voucher_id === admin[1]);
      if (!voucher) return reject('VOUCHER_NOT_FOUND', 'Voucher not found', 404);
      if (method === 'GET') return json({ voucher });
      if (method === 'PATCH') { Object.assign(voucher, admin[2] ? { status: 'disabled' } : request.postDataJSON()); return json({ voucher }); }
    }
    unexpected.push({ path, method }); return route.abort('blockedbyclient');
  });
  return { reads, writes, quotes, orders, unexpected, rows, catalog,
    setReady: value => { currentReady = value; }, setOnlineReady: value => { currentOnlineReady = value; },
    setReadinessError: value => { failReadiness = value; }, onQuote: handler => { quoteHandler = handler; },
    loseOrder: () => { loseOrder = true; }, failOrder: failure => { orderError = failure; },
    orderWrites: () => writes.filter(write => write.path === '/api/orders'),
    adminWrites: () => writes.filter(write => write.path.startsWith('/api/admin/vouchers')),
  };
}

async function openCheckout(page, options) {
  const mocked = await fixture(page, options);
  await page.goto('/checkout');
  await expect(submit(page)).toBeEnabled();
  return mocked;
}
async function applyCode(page, code = 'SAVE10') {
  await codeInput(page).fill(code); await apply(page).click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('123456.78'));
}

test('Readiness tắt hoặc chưa xác nhận: không hiển thị nhập mã và không gọi quote', async ({ page }) => {
  const mocked = await openCheckout(page, { ready: false });
  await expect(codeInput(page)).toHaveCount(0);
  expect(mocked.quotes).toEqual([]);
  mocked.setReady(true); mocked.setReadinessError(true);
  await page.reload();
  await expect(submit(page)).toBeEnabled();
  await expect(codeInput(page)).toHaveCount(0);
  expect(mocked.quotes).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Admin readiness tắt: ẩn menu và chặn mọi API quản lý, không suy đoán từ lỗi CRUD', async ({ page }) => {
  const mocked = await fixture(page, { role: 'admin', checkout: false, ready: false });
  await page.goto('/admin/vouchers');
  await expect(page.locator('main')).toContainText(/chưa.*(sẵn sàng|kích hoạt)|chưa.*khả dụng/i);
  await expect(page.getByRole('link', { name: 'Quản lý Voucher', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tạo Voucher', exact: true })).toHaveCount(0);
  expect(mocked.reads.filter(read => read.path.startsWith('/api/admin/vouchers'))).toEqual([]);
  expect(mocked.adminWrites()).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Đăng nhập Admin quay đúng trang Voucher, giữ returnTo khi chuyển đăng ký và đăng nhập', async ({ page }) => {
  const mocked = await fixture(page, { role: 'admin', checkout: false, authenticated: false });
  await page.goto('/admin/vouchers');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/admin/vouchers');
  expect(mocked.reads.filter(read => read.path.startsWith('/api/admin/vouchers'))).toEqual([]);
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/register\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/admin/vouchers');
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/admin/vouchers');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('voucher-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Synthetic-voucher-login-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/vouchers$/);
  await expect(voucherRow(page)).toContainText('SAVE10');
  expect(mocked.writes.filter(write => write.path === '/api/auth/login')).toHaveLength(1);
  expect(mocked.adminWrites()).toEqual([]);
  expect(mocked.orderWrites()).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Checkout hiển thị số tiền backend, gửi duy nhất mã và không nhận giá/giảm từ trình duyệt', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page, 'save10');
  await expect(page.locator('main')).toContainText(currency('76543.22'));
  expect(mocked.quotes.at(-1)).toEqual({ code: 'SAVE10', items: [{ product_id: 1, quantity: 2 }], payment_method: 'COD' });
  await submit(page).click();
  await expect(page.locator('.checkout-confirmation')).toContainText('8801');
  expect(mocked.orderWrites()).toHaveLength(1);
  expect(mocked.orderWrites()[0].body).toMatchObject({ voucher_code: 'SAVE10', payment_method: 'COD', items: [{ product_id: 1, quantity: 2 }] });
  expect(Object.keys(mocked.orderWrites()[0].body).filter(key => /amount|discount|price/.test(key))).toEqual([]);
  await expect(page.locator('.checkout-total')).toHaveText(currency('123456.78'));
  expect(mocked.unexpected).toEqual([]);
});

test('Bỏ Voucher trở về tổng gốc và payload không chứa voucher_code', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page);
  await page.getByRole('button', { name: /Bỏ Voucher/i }).click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('200000.00'));
  await submit(page).click();
  await expect(page.locator('.checkout-confirmation')).toBeVisible();
  expect(mocked.orderWrites()[0].body).not.toHaveProperty('voucher_code');
  expect(mocked.unexpected).toEqual([]);
});

test('COD tổng 0đ vẫn đặt được và hiển thị đúng tổng thực tế trên biên nhận', async ({ page }) => {
  const mocked = await openCheckout(page);
  await codeInput(page).fill('FREE'); await apply(page).click();
  await expect(page.locator('.checkout-total')).toHaveText(currency('0.00'));
  await expect(page.locator('.checkout-voucher-discount')).toContainText(currency('200000.00'));
  await expect(submit(page)).toBeEnabled(); await submit(page).click();
  await expect(page.locator('.checkout-confirmation')).toContainText('8801');
  await expect(page.locator('.checkout-total')).toHaveText(currency('0.00'));
  expect(mocked.orderWrites()[0].body).toMatchObject({ payment_method: 'COD', voucher_code: 'FREE' });
  expect(mocked.orders[0].total_amount).toBe('0.00');
  expect(mocked.unexpected).toEqual([]);
});

test('Đổi COD sang Online kiểm tra lại mã và hiển thị lỗi Online 0đ do backend', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page);
  mocked.onQuote(({ body, json, reject, quoted }) => body.payment_method === 'ONLINE'
    ? reject('VOUCHER_ONLINE_ZERO_TOTAL', 'Không thể áp dụng Voucher cho đơn Online có tổng thanh toán 0đ.')
    : json({ quote: quoted(body) }));
  await page.getByRole('radio', { name: /Thanh toán online/i }).check();
  await expect.poll(() => mocked.quotes.some(body => body.payment_method === 'ONLINE')).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: /Online.*0đ/i })).toBeVisible();
  expect(mocked.orderWrites()).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Phản hồi quote cũ đến sau không ghi đè mã và số tiền vừa áp dụng', async ({ page }) => {
  const mocked = await openCheckout(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mocked.onQuote(async ({ body, json, quoted }) => {
    if (body.code === 'FIRST') await gate;
    const quote = quoted(body);
    if (body.code === 'SECOND') Object.assign(quote, { discount_amount: '101234.57', total_amount: '98765.43' });
    return json({ quote });
  });
  try {
    await codeInput(page).fill('FIRST'); await apply(page).click();
    await expect.poll(() => mocked.quotes.some(body => body.code === 'FIRST')).toBe(true);
    await codeInput(page).fill('SECOND');
    await expect(apply(page)).toBeEnabled(); await apply(page).click();
    await expect(page.locator('.checkout-total')).toHaveText(currency('98765.43'));
    release();
    await expect(page.locator('.checkout-voucher-applied')).toContainText('SECOND');
    await expect(page.locator('.checkout-total')).toHaveText(currency('98765.43'));
    await submit(page).click();
    await expect(page.locator('.checkout-confirmation')).toBeVisible();
    expect(mocked.orderWrites()[0].body.voucher_code).toBe('SECOND');
    expect(mocked.unexpected).toEqual([]);
  } finally { release(); }
});

test('Refresh giá không sử dụng quote cũ; backend được hỏi lại với snapshot hiện tại', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page);
  const before = mocked.quotes.length;
  mocked.catalog[0].price = '120000.00';
  await page.getByRole('button', { name: 'Cập nhật giá và tồn kho', exact: true }).click();
  await expect(page.locator('.checkout-subtotal')).toHaveText(currency('240000.00'));
  await expect.poll(() => mocked.quotes.length).toBeGreaterThan(before);
  expect(mocked.quotes.at(-1)).toMatchObject({ items: [{ product_id: 1, quantity: 2 }], payment_method: 'COD' });
  expect(mocked.orderWrites()).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Đổi số lượng và sản phẩm trong bản nháp kiểm tra lại Voucher với snapshot mới sau reload', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page);
  const beforeQuantityChange = mocked.quotes.length;
  await page.evaluate(() => {
    const key = 'petcare.checkout-draft.v1';
    const draft = JSON.parse(sessionStorage.getItem(key));
    draft.items = [{ product_id: 1, quantity: 3 }];
    sessionStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await expect.poll(() => mocked.quotes.length).toBeGreaterThan(beforeQuantityChange);
  await expect.poll(() => mocked.quotes.at(-1).items).toEqual([{ product_id: 1, quantity: 3 }]);
  await expect(page.locator('.checkout-subtotal')).toHaveText(currency('300000.00'));
  await expect(page.locator('.checkout-voucher-applied')).toContainText('SAVE10');
  mocked.catalog.push({ ...mocked.catalog[0], product_id: 2, name: 'Sản phẩm Voucher thứ hai giả lập', price: '50000.00' });
  const beforeProductChange = mocked.quotes.length;
  await page.evaluate(() => {
    const key = 'petcare.checkout-draft.v1';
    const draft = JSON.parse(sessionStorage.getItem(key));
    draft.items = [{ product_id: 2, quantity: 4 }]; draft.prices = { 2: '50000.00' };
    sessionStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await expect.poll(() => mocked.quotes.length).toBeGreaterThan(beforeProductChange);
  await expect.poll(() => mocked.quotes.at(-1).items).toEqual([{ product_id: 2, quantity: 4 }]);
  await expect(page.locator('.checkout-subtotal')).toHaveText(currency('200000.00'));
  await expect(page.locator('.checkout-item[data-product-id="2"]')).toContainText('Sản phẩm Voucher thứ hai giả lập');
  await expect(page.locator('.checkout-item-quantity')).toContainText('4');
  expect(mocked.orderWrites()).toEqual([]);
  expect(mocked.unexpected).toEqual([]);
});

test('Mất phản hồi sau commit giữ nguyên key và mã qua reload dù Voucher đã tắt', async ({ page }) => {
  const mocked = await openCheckout(page);
  await applyCode(page);
  mocked.loseOrder(); await submit(page).click();
  await expect(submit(page)).toContainText(/Thử lại/i);
  const first = mocked.orderWrites()[0];
  expect(first.body.voucher_code).toBe('SAVE10');
  mocked.setReady(false); await page.reload();
  await expect(submit(page)).toBeEnabled();
  await expect(submit(page)).toContainText(/Thử lại/i);
  await submit(page).click();
  await expect(page.locator('.checkout-confirmation')).toContainText('8801');
  expect(mocked.orderWrites()).toHaveLength(2);
  expect(mocked.orderWrites()[1]).toMatchObject({ key: first.key, body: first.body });
  expect(mocked.orders).toHaveLength(1);
  expect(mocked.unexpected).toEqual([]);
});

test('Admin danh sách, chi tiết, sửa và vô hiệu hóa chỉ sau xác nhận', async ({ page }, testInfo) => {
  const mocked = await fixture(page, { role: 'admin', checkout: false });
  await page.goto('/admin/vouchers');
  await expect(voucherRow(page)).toContainText('SAVE10');
  await expect(voucherRow(page)).toContainText('100');
  await page.screenshot({ path: testInfo.outputPath('voucher-admin-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Xem Voucher SAVE10', exact: true }).click();
  await expect(dialog(page)).toContainText('Chi tiết Voucher SAVE10');
  await dialog(page).getByRole('button', { name: 'Đóng hộp thoại', exact: true }).click();
  await page.getByRole('button', { name: 'Sửa Voucher SAVE10', exact: true }).click();
  // Disabling must use the explicit confirmation flow, never the edit form.
  await expect(page.locator('#admin-voucher-status option[value="disabled"]')).toHaveCount(0);
  await page.locator('#admin-voucher-discount_value').fill('15');
  await dialog(page).getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mocked.adminWrites().at(-1)).toMatchObject({ method: 'PATCH', body: { discount_value: '15.00' } });
  expect(mocked.adminWrites().at(-1).body.status).not.toBe('disabled');
  await page.getByRole('button', { name: 'Vô hiệu hóa Voucher SAVE10', exact: true }).click();
  await expect(dialog(page)).toContainText('Vô hiệu hóa Voucher');
  expect(mocked.adminWrites()).toHaveLength(1);
  await dialog(page).getByRole('button', { name: 'Xác nhận vô hiệu hóa', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mocked.adminWrites().at(-1)).toMatchObject({ path: '/api/admin/vouchers/1/disable', method: 'PATCH', body: {} });
  expect(mocked.rows[0].status).toBe('disabled');
  expect(mocked.unexpected).toEqual([]);
});

test('Admin tạo Voucher chuẩn hóa tiền/quota và đổi thời gian địa phương sang UTC', async ({ page }) => {
  const mocked = await fixture(page, { role: 'admin', checkout: false });
  await page.goto('/admin/vouchers');
  await page.getByRole('button', { name: 'Tạo Voucher', exact: true }).click();
  await expect(page.locator('#admin-voucher-status option[value="disabled"]')).toHaveCount(0);
  await page.locator('#admin-voucher-code').fill('newfixed');
  await page.locator('#admin-voucher-discount_type').selectOption('fixed');
  await page.locator('#admin-voucher-discount_value').fill('20000');
  await page.locator('#admin-voucher-minimum_order_amount').fill('100000');
  await page.locator('#admin-voucher-max_discount_amount').fill('25000');
  await page.locator('#admin-voucher-starts_at_utc').fill('2026-12-01T10:30');
  await page.locator('#admin-voucher-ends_at_utc').fill('2026-12-02T10:30');
  await page.locator('#admin-voucher-total_limit').fill('50');
  await page.locator('#admin-voucher-per_user_limit').fill('2');
  await page.locator('#admin-voucher-status').selectOption('active');
  await dialog(page).getByRole('button', { name: 'Tạo Voucher', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mocked.adminWrites().at(-1)).toMatchObject({ method: 'POST', body: { code: 'NEWFIXED', discount_type: 'fixed', discount_value: '20000.00', minimum_order_amount: '100000.00', max_discount_amount: '25000.00', starts_at_utc: '2026-12-01T03:30:00.000Z', ends_at_utc: '2026-12-02T03:30:00.000Z', total_limit: 50, per_user_limit: 2, status: 'active' } });
  await expect(voucherRow(page, '2')).toContainText('NEWFIXED');
  expect(mocked.unexpected).toEqual([]);
});

test('Mobile Admin không tràn khung; quản lý Voucher truy cập được trong menu', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mocked = await fixture(page, { role: 'admin', checkout: false });
  await page.goto('/admin/vouchers');
  await expect(voucherRow(page)).toBeVisible();
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click();
  await expect(page.locator('#mobile-menu').getByRole('link', { name: 'Quản lý Voucher', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Đóng menu', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo Voucher', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('voucher-admin-mobile.png'), fullPage: true });
  expect(await dialog(page).evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= window.innerWidth; })).toBe(true);
  expect(mocked.unexpected).toEqual([]);
});

test('Mobile checkout hiển thị mã, giảm giá và tổng từ backend trong khung nhìn', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mocked = await openCheckout(page);
  await applyCode(page);
  await page.screenshot({ path: testInfo.outputPath('voucher-checkout-mobile.png'), fullPage: true });
  await expect(page.locator('.checkout-voucher-discount')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(submit(page)).toBeEnabled();
  expect(mocked.unexpected).toEqual([]);
});

test('Lỗi hết hạn, hết lượt và không đủ điều kiện giữ nguyên thông báo rõ ràng từ backend', async ({ page }) => {
  const mocked = await openCheckout(page);
  for (const [code, message, pattern] of [['VOUCHER_EXPIRED', 'Mã Voucher đã hết hạn.', /hết hạn/i], ['VOUCHER_QUOTA_EXCEEDED', 'Voucher đã hết lượt sử dụng.', /hết lượt|giới hạn/i], ['VOUCHER_MINIMUM_NOT_MET', 'Đơn hàng chưa đủ điều kiện áp dụng Voucher.', /điều kiện|tối thiểu/i]]) {
    mocked.onQuote(({ reject }) => reject(code, message));
    const previous = mocked.quotes.length;
    await codeInput(page).fill('SAVE10'); await apply(page).click();
    await expect.poll(() => mocked.quotes.length).toBeGreaterThan(previous);
    await expect(page.getByRole('alert').filter({ hasText: pattern })).toBeVisible();
    expect(mocked.orderWrites()).toEqual([]);
  }
  expect(mocked.unexpected).toEqual([]);
});
