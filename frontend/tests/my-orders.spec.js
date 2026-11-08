import { test, expect } from '@playwright/test';
import { API, mockMyOrders, orderFixture, statuses, users, tokenFor, TOKEN_KEY, formatPrice, loginForOrders, expectNoOrderMutations } from './helpers/my-orders-fixtures.js';

const cards = page => page.locator('.my-order-card');
const filter = page => page.getByLabel('Trạng thái đơn hàng', { exact: true });

test('danh sách đơn dùng dữ liệu API có JWT, hiển thị sản phẩm/số lượng/tiền/ngày/trạng thái và không nhận user_id', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/my-orders?user_id=920002');
  await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi', exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(10);
  const order = account.orders.find(row => row.order_id === 512);
  const first = page.locator('.my-order-card[data-order-id="512"]');
  await expect(first).toContainText('512');
  await expect(first).toContainText(order.items[0].name);
  await expect(first).toContainText(/(?:Số lượng\s*:?\s*2|[x×]\s*2|2\s*sản phẩm)/i);
  await expect(first).toContainText(formatPrice(order.total_amount));
  await expect(first).toContainText(order.status);
  await expect(first).toContainText(/31\/10\/2026|31 tháng 10,? 2026/);
  expect(account.reads[0].token).toBe(tokenFor('a'));
  expect(account.reads[0].query).toMatchObject({ page: '1', limit: '10' });
  expect(account.reads.every(read => !Object.hasOwn(read.query, 'user_id'))).toBe(true);
  await expect(page.locator('.my-orders-page')).not.toContainText('Đơn riêng chỉ thuộc tài khoản B');
  expectNoOrderMutations(account);
});

test('phân trang và bộ lọc chạy trên toàn bộ danh sách API, đổi lọc quay về trang1', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/my-orders');
  await expect(cards(page)).toHaveCount(10);
  await page.getByRole('button', { name: 'Trang tiếp theo', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  expect(account.reads.at(-1).query.page).toBe('2');
  await expect(page.getByRole('button', { name: 'Trang tiếp theo', exact: true })).toBeDisabled();
  await filter(page).selectOption({ label: 'Đã hủy' });
  await expect(cards(page)).toHaveCount(2);
  expect(account.reads.at(-1).query).toMatchObject({ page: '1', limit: '10', status: 'Đã hủy' });
  await expect(page.locator('.my-order-card[data-order-id="512"]')).toBeVisible();
  await expect(page.locator('.my-order-card[data-order-id="506"]')).toBeVisible();
  const options = await filter(page).locator('option').allTextContents();
  expect(options.filter(value => statuses.includes(value))).toEqual(statuses);
  expect(options).toHaveLength(statuses.length + 1);
  expectNoOrderMutations(account);
});

test('khách đăng ký rồi đăng nhập quay lại đúng Đơn hàng của tôi, không có dữ liệu trước xác thực', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: null });
  await page.goto('/my-orders');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders');
  expect(account.reads).toEqual([]);
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/register\?returnTo=/);
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill(users.a.full_name);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(users.a.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('MyOrders-test-2026!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('MyOrders-test-2026!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders');
  await loginForOrders(page);
  await expect(cards(page)).toHaveCount(10);
  expectNoOrderMutations(account);
});

test('401 khi đọc đơn xóa dữ liệu phiên cũ, đăng nhập lại trở về danh sách', async ({ page }) => {
  const account = await mockMyOrders(page, { fail: { status: 401, message: 'Invalid or expired token' } });
  await page.goto('/my-orders');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(await page.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
  await expect(cards(page)).toHaveCount(0);
  await loginForOrders(page);
  await expect(cards(page)).toHaveCount(10);
  expectNoOrderMutations(account);
});

test('đổi tài khoản tải lại chỉ hiển thị đơn thuộc tài khoản mới', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/my-orders');
  await expect(cards(page)).toHaveCount(10);
  await page.evaluate(({ key, token }) => sessionStorage.setItem(key, token), { key: TOKEN_KEY, token: tokenFor('b') });
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Đơn riêng chỉ thuộc tài khoản B');
  await expect(page.locator('.my-order-card[data-order-id="512"]')).toHaveCount(0);
  expect(account.reads.at(-1).token).toBe(tokenFor('b'));
  expectNoOrderMutations(account);
});

test('đang tải không hiển thị đơn giả, có kết quả thì bỏ trạng thái chờ', async ({ page }) => {
  const account = await mockMyOrders(page, { hold: true });
  await page.goto('/my-orders');
  await expect(page.locator('.my-orders-loading')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  account.release();
  await expect(cards(page)).toHaveCount(10);
  await expect(page.locator('.my-orders-loading')).toHaveCount(0);
  expectNoOrderMutations(account);
});

test('tài khoản chưa có đơn hiển thị trạng thái trống và liên kết mua sắm', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [] });
  await page.goto('/my-orders');
  await expect(page.locator('.my-orders-empty')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('.my-orders-page').getByRole('link').filter({ hasText: /mua sắm|sản phẩm/i }).last()).toHaveAttribute('href', '/products');
  expectNoOrderMutations(account);
});

test('lọc trạng thái không có kết quả vẫn giữ bộ lọc và không dựng đơn giả', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [orderFixture(601, 'a', { status: 'Chờ xử lý' })] });
  await page.goto('/my-orders');
  await expect(cards(page)).toHaveCount(1);
  await filter(page).selectOption({ label: 'Đã hủy' });
  await expect(page.locator('.my-orders-empty')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(filter(page)).toHaveValue('Đã hủy');
  expect(account.reads.at(-1).query.status).toBe('Đã hủy');
  expectNoOrderMutations(account);
});

test('lỗi API có thông báo và Thử lại lấy lại dữ liệu thật từ API fixture', async ({ page }) => {
  const account = await mockMyOrders(page, { fail: { status: 500 } });
  await page.goto('/my-orders');
  await expect(page.locator('.my-orders-error')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await page.locator('.my-orders-error').getByRole('button', { name: /Thử lại/i }).click();
  await expect(cards(page)).toHaveCount(10);
  await expect(page.locator('.my-orders-error')).toHaveCount(0);
  expect(account.reads.length).toBeGreaterThanOrEqual(2);
  expectNoOrderMutations(account);
});

test('Xem chi tiết mở đúng route và đọc thông tin thật từ API chi tiết', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/my-orders');
  await expect(cards(page)).toHaveCount(10);
  const link = page.locator('.my-order-card[data-order-id="512"] .my-order-details');
  await expect(link).toHaveAttribute('href', '/my-orders/512');
  await link.click();
  await expect(page).toHaveURL(/\/my-orders\/512$/);
  await expect(page.getByRole('heading', { name: 'Chi tiết đơn hàng', exact: true })).toBeVisible();
  await expect(page.locator('.order-detail-page')).toContainText('Sản phẩm đơn 512');
  await expect(cards(page)).toHaveCount(0);
  expect(account.detailReads.at(-1).url).toBe(`${API}/api/orders/512`);
  expectNoOrderMutations(account);
});

test('Header của khách hàng mở Đơn hàng của tôi', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/');
  await expect(page.locator('.site-header .account-action')).toContainText(users.a.full_name);
  await page.locator('.site-header .account-action').click();
  await expect(page).toHaveURL(/\/my-orders$/);
  await expect(cards(page)).toHaveCount(10);
  expectNoOrderMutations(account);
});

test('Admin giữ nguyên phiên và không gọi API đơn khách hàng', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: 'admin' });
  await page.goto('/my-orders');
  await expect(page.locator('.my-orders-state')).toContainText('tài khoản khách hàng');
  await expect(cards(page)).toHaveCount(0);
  expect(account.reads).toEqual([]);
  expect(await page.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY)).toBe(tokenFor('admin'));
  expectNoOrderMutations(account);
});

test('response sai chủ đơn bị từ chối trước khi hiển thị thông tin tài khoản khác', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.route(`${API}/api/orders**`, route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { success: true, page: 1, limit: 10, total: 1, statuses, orders: [orderFixture(9999, 'b', { items: [{ ...orderFixture(9999, 'b').items[0], name: 'Thông tin riêng không được hiển thị' }] })] },
  }));
  await page.goto('/my-orders');
  await expect(page.locator('.my-orders-error')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Thông tin riêng không được hiển thị');
  expectNoOrderMutations(account);
});

test('response bộ lọc cũ đến muộn không thay thế kết quả bộ lọc mới', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.goto('/my-orders');
  await expect(cards(page)).toHaveCount(10);
  let release, handled;
  const gate = new Promise(resolve => { release = resolve; });
  const finished = new Promise(resolve => { handled = resolve; });
  await page.route(`${API}/api/orders**`, async route => {
    if (new URL(route.request().url()).searchParams.get('status') !== 'Chờ xử lý') return route.fallback();
    await gate;
    try {
      await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { success: true, total: 1, statuses, orders: [orderFixture(8888)] } });
    } catch { /* The old fetch has already been cancelled by the application. */ }
    finally { handled(); }
  });
  await filter(page).selectOption({ label: 'Chờ xử lý' });
  await expect(page.locator('.my-orders-loading')).toBeVisible();
  await filter(page).selectOption({ label: 'Đã giao hàng' });
  await expect(cards(page)).toHaveCount(2);
  release(); await finished;
  await expect(filter(page)).toHaveValue('Đã giao hàng');
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('.my-order-card[data-order-id="8888"]')).toHaveCount(0);
  expectNoOrderMutations(account);
});

for (const width of [1440, 768, 390, 320]) {
  test(`Đơn hàng responsive ${width}px giữ nội dung, lọc và nút trong màn hình`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const order = orderFixture(701, 'a', { items: [{ ...orderFixture(701).items[0], name: 'Tên sản phẩm dài để kiểm tra xuống dòng trên điện thoại '.repeat(5), image_url: '/images/products/does-not-exist.webp' }] });
    const account = await mockMyOrders(page, { orders: [order] });
    await page.goto('/my-orders');
    await expect(cards(page)).toHaveCount(1);
    await expect(filter(page)).toBeVisible();
    await expect(page.locator('.my-order-details')).toBeVisible();
    expect(await page.locator('.my-orders-page').evaluate(element => [...element.querySelectorAll('select, button, .my-order-card, .my-order-details')].every(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }) && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if ([1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`my-orders-${width}.png`), fullPage: true });
    expectNoOrderMutations(account);
  });
}
