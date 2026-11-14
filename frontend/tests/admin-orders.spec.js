import { test, expect } from '@playwright/test';
import { adminOrder, mockAdminOrders, users } from './helpers/admin-orders-fixtures.js';
import { formatPrice } from './helpers/my-orders-fixtures.js';

const row = (page, id) => page.locator(`[data-order-id="${id}"]`);
const confirmation = page => page.getByRole('dialog');
const noUnexpected = fixture => expect(fixture.unexpected).toEqual([]);
const pendingOnline = () => adminOrder(802, { payment_method: 'ONLINE', status: 'Chờ thanh toán' });

test('Admin danh sách phân trang, tìm mã/điện thoại và lọc chờ duyệt bằng API', async ({ page }) => {
  const fixture = await mockAdminOrders(page);
  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Xem chi tiết', exact: true })).toHaveCount(20);
  await page.getByRole('button', { name: 'Trang tiếp theo', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Xem chi tiết', exact: true })).toHaveCount(3);
  expect(fixture.reads.at(-1).query.page).toBe('2');
  await page.getByLabel('Tìm mã đơn hoặc số điện thoại', { exact: true }).fill('801');
  await page.locator('.admin-orders-search').getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Xem chi tiết', exact: true })).toHaveCount(1);
  await expect(row(page, 801)).toContainText('0912345678');
  expect(fixture.reads.at(-1).query).toMatchObject({ page: '1', q: '801' });
  await page.getByLabel('Tìm mã đơn hoặc số điện thoại', { exact: true }).fill('091234');
  await page.locator('.admin-orders-search').getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await page.getByLabel('Lọc trạng thái đơn', { exact: true }).selectOption('pending');
  await expect(row(page, 801)).toBeVisible();
  expect(fixture.reads.at(-1).query).toMatchObject({ q: '091234', approval: 'pending' });
  await page.getByLabel('Lọc trạng thái đơn', { exact: true }).selectOption('rejected');
  await expect(page.locator('.admin-orders-empty')).toContainText('Không tìm thấy đơn phù hợp');
  expect(fixture.reads.at(-1).query.approval).toBe('rejected');
  await page.reload();
  await expect(page.getByLabel('Lọc trạng thái đơn', { exact: true })).toHaveValue('rejected');
  await page.getByLabel('Lọc trạng thái đơn', { exact: true }).selectOption('approved');
  await expect(page.locator('.admin-orders-empty')).toContainText('Không tìm thấy đơn phù hợp');
  expect(fixture.reads.at(-1).query.approval).toBe('approved');
  expect(fixture.writes).toEqual([]);
  noUnexpected(fixture);
});

test('Xem chi tiết giữ đơn giá lịch sử, người nhận Unicode, địa chỉ và ghi chú xuống dòng', async ({ page }) => {
  const order = adminOrder(801, {
    recipient_name: 'Nguyễn Thị Ánh — Khách nhận hàng 🐾', shipping_address: 'Căn hộ 1508, Tòa Ánh Dương\nThành phố Hồ Chí Minh', note: 'Gọi trước khi giao.\nGiữ nguyên bao bì.',
    history: [{ history_id: 1, from_status: null, to_status: 'Chờ xử lý', action: 'created', created_at: '2026-10-31T08:15:00.000Z', actor_name: 'Khách hàng A' }],
  });
  const fixture = await mockAdminOrders(page, { orders: [order] });
  await page.goto('/admin/orders');
  await row(page, 801).getByRole('link', { name: 'Xem chi tiết', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/801$/);
  for (const value of [order.recipient_name, order.phone, order.items[0].name, formatPrice(order.items[0].unit_price), formatPrice(order.total_amount)]) await expect(page.locator('main')).toContainText(value);
  expect(await page.locator('main').textContent()).toContain(order.shipping_address);
  expect(await page.locator('main').textContent()).toContain(order.note);
  await expect(page.locator('.order-history li')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('main')).toContainText(order.recipient_name);
  expect(fixture.writes).toEqual([]);
  noUnexpected(fixture);
});

test('khách phải đăng nhập Admin rồi quay đúng chi tiết đang mở', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { owner: null, orders: [adminOrder()] });
  await page.goto('/admin/orders/801');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/admin/orders/801');
  expect(fixture.reads).toEqual([]);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(users.admin.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Admin-test-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/801$/);
  await expect(page.getByRole('button', { name: 'Duyệt đơn', exact: true })).toBeVisible();
  noUnexpected(fixture);
});

test('tài khoản khách không đọc đơn Admin, không làm mất phiên đăng nhập', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { owner: 'a' });
  await page.goto('/admin/orders');
  await expect(page.locator('main')).toContainText(/không có quyền|dành cho.*quản trị|quyền quản trị/i);
  expect(fixture.reads).toEqual([]);
  expect(fixture.writes).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeTruthy();
  noUnexpected(fixture);
});

test('loading, danh sách trống và lỗi có Thử lại không dựng dữ liệu', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [], hold: true });
  await page.goto('/admin/orders');
  await expect(page.getByRole('status').filter({ hasText: /đang tải/i }).first()).toBeVisible();
  expect(fixture.writes).toEqual([]);
  fixture.release();
  await expect(page.locator('main')).toContainText(/chưa có đơn|không có đơn/i);
  await expect(page.getByRole('link', { name: 'Xem chi tiết', exact: true })).toHaveCount(0);
  noUnexpected(fixture);
});

test('lỗi đọc có thể thử lại từ API', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [adminOrder()], fail: { status: 500, message: 'Không tải được đơn kiểm thử' } });
  await page.goto('/admin/orders');
  await expect(page.locator('main')).toContainText('Không tải được đơn kiểm thử');
  await page.getByRole('button', { name: /Thử lại/i }).click();
  await expect(row(page, 801)).toBeVisible();
  expect(fixture.reads.length).toBeGreaterThanOrEqual(2);
  noUnexpected(fixture);
});

test('duyệt COD cần xác nhận, gửi đúng một lần khi double click và chuyển chờ giao', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [adminOrder()], holdMutation: true });
  await page.goto('/admin/orders/801');
  await page.getByRole('button', { name: 'Duyệt đơn', exact: true }).click();
  await expect(confirmation(page)).toHaveAccessibleName('Xác nhận duyệt đơn');
  expect(fixture.writes).toEqual([]);
  const confirm = confirmation(page).locator('.admin-orders-confirm-submit');
  await confirm.evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(confirm).toBeDisabled();
  expect(fixture.writes[0]).toMatchObject({ path: '/api/admin/orders/801/approve', method: 'PATCH', body: {} });
  fixture.releaseMutation();
  await expect(confirmation(page)).not.toBeVisible();
  await expect(page.locator('main')).toContainText('Chờ giao hàng');
  await expect(page.getByRole('button', { name: 'Bắt đầu giao hàng', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duyệt đơn', exact: true })).toHaveCount(0);
  noUnexpected(fixture);
});

test('từ chối bắt buộc lý do, lưu đúng Unicode và hiển thị lịch sử', async ({ page }) => {
  const reason = 'Địa chỉ chưa phục vụ.\nXin kiểm tra địa chỉ nhận hàng. 🐾';
  const fixture = await mockAdminOrders(page, { orders: [adminOrder()] });
  await page.goto('/admin/orders/801');
  await page.getByRole('button', { name: 'Từ chối đơn', exact: true }).click();
  await expect(confirmation(page)).toHaveAccessibleName('Xác nhận từ chối đơn');
  await expect(confirmation(page).getByRole('button', { name: 'Xác nhận từ chối', exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  await confirmation(page).getByRole('textbox', { name: 'Lý do từ chối', exact: true }).fill(reason);
  await confirmation(page).getByRole('button', { name: 'Xác nhận từ chối', exact: true }).click();
  await expect(confirmation(page)).not.toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({ path: '/api/admin/orders/801/reject', body: { reason } });
  expect(await page.locator('main').textContent()).toContain(reason);
  await expect(page.locator('.order-history')).toContainText('Từ chối đơn');
  await expect(page.getByRole('button', { name: 'Duyệt đơn', exact: true })).toHaveCount(0);
  noUnexpected(fixture);
});

test('Admin xem đúng đơn khách hủy, lịch sử và trạng thái hoàn tiền chưa hoàn tất', async ({ page }) => {
  const reason = 'Tôi cần thay đổi địa chỉ nhận hàng.\nGiao tới văn phòng mới 🐾';
  const cancelledAt = '2026-10-31T10:00:00.000Z';
  const order = adminOrder(801, {
    status: 'Đã hủy', approval_state: 'cancelled', payment_method: 'ONLINE', payment_status: 'Đã thanh toán',
    workflow_version: 2, transaction_date: '2026-10-31T09:00:00.000Z',
    cancellation_reason_code: 'customer_cancelled', cancellation_reason: reason, cancelled_at: cancelledAt,
    history: [{ history_id: 2, from_status: 'Chờ xử lý', to_status: 'Đã hủy', action: 'cancel', created_at: cancelledAt, actor_name: users.a.full_name, reason }],
    refunds: [{ refund_id: 42, amount: '151000.00', currency: 'VND', reason_code: 'customer_cancelled', status: 'requested', requested_at_utc: cancelledAt, confirmed_at_utc: null }],
  });
  const fixture = await mockAdminOrders(page, { orders: [order] });
  await page.route('**/api/vouchers/readiness', route => route.request().method() === 'GET'
    ? route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { success: true, readiness: { ready: false, online_ready: false } } })
    : route.fallback());
  await page.goto('/admin/orders');
  await expect(row(page, 801).locator('.my-order-status')).toHaveText('Đã hủy');
  await page.getByLabel('Lọc trạng thái đơn', { exact: true }).selectOption('rejected');
  await expect(row(page, 801)).toHaveCount(0);
  await page.getByLabel('Lọc trạng thái đơn', { exact: true }).selectOption('Đã hủy');
  await row(page, 801).getByRole('link', { name: 'Xem chi tiết', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Khách hàng đã hủy đơn', exact: true })).toBeVisible();
  expect(await page.locator('.admin-orders-cancellation').textContent()).toContain(reason);
  await expect(page.locator('.admin-orders-cancellation time')).toHaveAttribute('dateTime', cancelledAt);
  await expect(page.locator('.order-history')).toContainText('Khách hàng hủy đơn');
  await expect(page.locator('.admin-orders-refunds')).toContainText('Đã ghi nhận yêu cầu hoàn tiền');
  await expect(page.locator('.admin-orders-refunds li > strong')).not.toHaveText('Đã hoàn tiền');
  await expect(page.locator('.admin-orders-payment-status')).toHaveText('Đã thanh toán');
  await expect(page.getByRole('button', { name: 'Duyệt đơn', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Từ chối đơn', exact: true })).toHaveCount(0);
  order.refunds[0].status = 'succeeded';
  order.refunds[0].confirmed_at_utc = '2026-10-31T11:00:00.000Z';
  await page.getByRole('button', { name: 'Cập nhật đơn hàng', exact: true }).click();
  await expect(page.locator('.admin-orders-refunds li > strong')).toHaveText('Đã hoàn tiền');
  await expect(page.locator('.admin-orders-refunds')).toContainText('Hoàn tất hoàn tiền');
  expect(fixture.writes).toEqual([]);
  noUnexpected(fixture);
});

test('COD giao hàng tuần tự, chỉ hoàn tất khi xác nhận đã thu tiền', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [adminOrder(801, { status: 'Chờ giao hàng', approved_at: '2026-10-31T09:00:00.000Z' })] });
  await page.goto('/admin/orders/801');
  await page.getByRole('button', { name: 'Bắt đầu giao hàng', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Xác nhận giao hàng', exact: true }).click();
  await expect(confirmation(page)).not.toBeVisible();
  expect(fixture.writes[0].body).toEqual({ status: 'Đang giao hàng' });
  await page.getByRole('button', { name: 'Xác nhận đã giao', exact: true }).click();
  await expect(confirmation(page).getByRole('button', { name: 'Xác nhận hoàn tất', exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  await confirmation(page).getByLabel('Đã giao hàng và đã thu đủ tiền COD', { exact: true }).check();
  await confirmation(page).getByRole('button', { name: 'Xác nhận hoàn tất', exact: true }).click();
  await expect(confirmation(page)).not.toBeVisible();
  expect(fixture.writes[1].body).toEqual({ status: 'Đã giao hàng', cod_payment_received: true });
  await expect(page.locator('main')).toContainText('Đã thanh toán');
  await expect(page.getByRole('button', { name: 'Xác nhận đã giao', exact: true })).toHaveCount(0);
  noUnexpected(fixture);
});

test('Online sau duyệt phải chờ thanh toán; không có nút bỏ bước hay thanh toán giả', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [pendingOnline()] });
  await page.goto('/admin/orders/802');
  await expect(page.locator('main')).toContainText('Chờ duyệt');
  await page.getByRole('button', { name: 'Duyệt đơn', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Xác nhận duyệt', exact: true }).click();
  await expect(confirmation(page)).not.toBeVisible();
  await expect(page.locator('main')).toContainText('Chờ thanh toán');
  await expect(page.getByRole('button', { name: 'Bắt đầu giao hàng', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Thanh toán|mô phỏng/i })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.orders[0].payment_status).toBe('Chưa thanh toán');
  noUnexpected(fixture);
});

test('409 thao tác cạnh tranh không báo thành công, cho tải lại trạng thái server', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [adminOrder()], mutationFail: { status: 409, message: 'Đơn đã thay đổi ở phiên khác, vui lòng tải lại.' } });
  await page.goto('/admin/orders/801');
  await page.getByRole('button', { name: 'Duyệt đơn', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Xác nhận duyệt', exact: true }).click();
  await expect(page.locator('main')).toContainText('Đơn đã thay đổi ở phiên khác');
  expect(fixture.orders[0].approved_at).toBeNull();
  if (await confirmation(page).isVisible()) await confirmation(page).getByRole('button', { name: 'Quay lại', exact: true }).click();
  await page.getByRole('button', { name: 'Cập nhật đơn hàng', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Duyệt đơn', exact: true })).toBeVisible();
  noUnexpected(fixture);
});

test('đơn không tồn tại trả thông báo và giữ liên kết danh sách', async ({ page }) => {
  const fixture = await mockAdminOrders(page, { orders: [] });
  await page.goto('/admin/orders/999999');
  await expect(page.locator('main')).toContainText(/không tìm thấy|không tồn tại/i);
  await expect(page.locator('main').getByRole('link', { name: /danh sách đơn/i }).last()).toHaveAttribute('href', '/admin/orders');
  expect(fixture.writes).toEqual([]);
  noUnexpected(fixture);
});

for (const width of [1440, 390, 320]) {
  test(`Admin chi tiết responsive ${width}px với địa chỉ dài và ảnh không tràn`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const order = adminOrder(801, { shipping_address: 'Căn hộ, tầng, tòa nhà; địa chỉ dài Nguyễn Hữu Cảnh '.repeat(6), note: 'Gọi trước khi giao.\n'.repeat(8) });
    order.items[0].name = 'Sản phẩm dài với nhiều thông tin cần xuống dòng '.repeat(6);
    const fixture = await mockAdminOrders(page, { orders: [order] });
    await page.goto('/admin/orders/801');
    await expect(page.locator('main')).toContainText(order.items[0].name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const image of await page.locator('main .my-order-image img').all()) expect(await image.evaluate(node => getComputedStyle(node).objectFit)).toBe('contain');
    if ([1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`admin-order-${width}.png`), fullPage: true });
    noUnexpected(fixture);
  });
}
