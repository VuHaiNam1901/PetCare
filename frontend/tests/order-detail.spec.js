import { test, expect } from '@playwright/test';
import {
  API, TOKEN_KEY, users, tokenFor, formatPrice, orderFixture,
  mockMyOrders, loginForOrders, expectNoOrderMutations,
} from './helpers/my-orders-fixtures.js';

const detailPage = page => page.locator('.order-detail-page');
const item = (page, productId) => page.locator(`.order-detail-item[data-product-id="${productId}"]`);
const noPaymentAction = async page => {
  await expect(detailPage(page).getByRole('button', { name: /^Thanh toán(?: ngay)?$/i })).toHaveCount(0);
  await expect(detailPage(page).getByRole('link', { name: /^Thanh toán(?: ngay)?$/i })).toHaveCount(0);
};
const populatedOrder = (changes = {}) => orderFixture(801, 'a', {
  recipient_name: 'Nguyễn Thị Ánh — Người nhận hàng',
  shipping_address: 'Căn hộ 1508, Tòa Ánh Dương, số 123 Đường Nguyễn Hữu Cảnh\nPhường Thạnh Mỹ Tây, Thành phố Hồ Chí Minh',
  phone: '0912345678',
  note: 'Vui lòng gọi trước khi giao.\nGửi bảo vệ nếu tôi chưa về; cảm ơn! 🐾',
  total_amount: '829700.00',
  items: [
    { order_detail_id: 8011, product_id: 1, name: 'Thức ăn mèo vị cá ngừ — sản phẩm lúc mua', image_url: '/images/products/1-me-o-tuna-thuc-an-hat-cho-meo-vi-ca-ngu-1-2kg.webp', quantity: 3, unit_price: '129900.00', subtotal: '389700.00' },
    { order_detail_id: 8012, product_id: 19, name: 'Dầu cá cho chó, chai 473 ml', image_url: '/images/products/19-shed-x-dau-ca-cho-cho-473ml.webp', quantity: 2, unit_price: '220000.00', subtotal: '440000.00' },
  ],
  ...changes,
});

test('URL chi tiết tải lại được, giữ giá lúc đặt, nhiều sản phẩm và đầy đủ Unicode/xuống dòng', async ({ page }) => {
  const order = populatedOrder();
  const account = await mockMyOrders(page, { orders: [order] });
  await page.goto('/my-orders/801?user_id=920002');
  await expect(page.getByRole('heading', { name: 'Chi tiết đơn hàng', exact: true })).toBeVisible();
  await expect(detailPage(page)).toContainText('801');
  await expect(detailPage(page)).toContainText(/31\/10\/2026|31 tháng 10,? 2026/);
  const shipping = page.locator('.order-detail-shipping');
  for (const text of [order.recipient_name, order.phone, order.shipping_address, order.note]) {
    expect(await shipping.textContent()).toContain(text);
  }
  expect(await shipping.evaluate(element => [...element.querySelectorAll('*')].some(node =>
    node.textContent === 'Căn hộ 1508, Tòa Ánh Dương, số 123 Đường Nguyễn Hữu Cảnh\nPhường Thạnh Mỹ Tây, Thành phố Hồ Chí Minh'
      && ['pre-wrap', 'pre-line', 'break-spaces'].includes(getComputedStyle(node).whiteSpace)))).toBe(true);
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  for (const product of order.items) {
    await expect(item(page, product.product_id)).toContainText(product.name);
    await expect(item(page, product.product_id)).toContainText(formatPrice(product.unit_price));
    await expect(item(page, product.product_id)).toContainText(formatPrice(product.subtotal));
    await expect(item(page, product.product_id)).toContainText(new RegExp(`(?:Số lượng\\s*:?\\s*${product.quantity}|[x×]\\s*${product.quantity})`, 'i'));
  }
  // The synthetic catalog currently lists product 1 at 85,000 and product 19
  // at 225,000. The order must keep its stored 129,900 and 220,000 prices.
  await expect(item(page, 1)).not.toContainText(formatPrice('85000.00'));
  await expect(item(page, 19)).not.toContainText(formatPrice('225000.00'));
  await expect(page.locator('.order-detail-total')).toContainText(formatPrice(order.total_amount));
  await expect(detailPage(page)).toContainText(/chưa (?:bao )?gồm phí vận chuyển|chưa tính phí vận chuyển/i);
  expect(account.detailReads.every(read => read.token === tokenFor('a') && Object.keys(read.query).length === 0)).toBe(true);
  await page.reload();
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  await expect(page.locator('.order-detail-total')).toContainText(formatPrice(order.total_amount));
  await page.locator('.order-detail-page').getByRole('link', { name: /Đơn hàng của tôi/i }).last().click();
  await expect(page).toHaveURL(/\/my-orders$/);
  await expect(page.locator('.my-order-card[data-order-id="801"]')).toBeVisible();
  expectNoOrderMutations(account);
});

test('COD hiển thị phương thức nhận hàng và trạng thái thanh toán tách biệt trạng thái đơn', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder({ status: 'Đang giao hàng' })] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-status')).toContainText('Đang giao hàng');
  await expect(page.locator('.order-detail-payment-status')).toContainText('Chưa thanh toán');
  await expect(page.locator('.order-detail-payment')).toContainText('Thanh toán khi nhận hàng');
  await expect(page.locator('.order-detail-payment')).toContainText('COD');
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('Online chưa được Admin duyệt phải chờ và không có hành động thanh toán giả', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder({ payment_method: 'ONLINE', status: 'Chờ thanh toán' })] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-payment')).toContainText('Đơn hàng cần được Admin duyệt trước khi thanh toán.');
  await expect(page.locator('.order-detail-status')).toContainText('Chờ duyệt');
  await expect(page.locator('.order-detail-payment-status')).toContainText('Chưa thanh toán');
  await expect.poll(() => account.paymentReads.length).toBeGreaterThan(0);
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('Online đã duyệt chỉ thông báo khả năng mô phỏng từ Backend, không tự thanh toán', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder({ payment_method: 'ONLINE', status: 'Chờ thanh toán', approved_at: '2026-10-31T09:00:00.000Z' })] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-payment')).toContainText(/đã được.*duyệt|đã duyệt/i);
  await expect(page.locator('.order-detail-payment')).toContainText(/mô phỏng/i);
  await expect(page.locator('.order-detail-payment')).toContainText('Giao diện thanh toán chưa được tích hợp');
  await expect(page.locator('.order-detail-payment-status')).toContainText('Chưa thanh toán');
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('Backend không cho mô phỏng dù có approved_at thì giao diện không tuyên bố đủ điều kiện', async ({ page }) => {
  const account = await mockMyOrders(page, {
    orders: [populatedOrder({ payment_method: 'ONLINE', status: 'Chờ thanh toán', approved_at: '2026-10-31T09:00:00.000Z' })],
    paymentOverrides: { 801: { can_simulate: false } },
  });
  await page.goto('/my-orders/801');
  await expect.poll(() => account.paymentReads.length).toBeGreaterThan(0);
  await expect(page.locator('.order-detail-payment')).not.toContainText(/đủ điều kiện|có thể thanh toán mô phỏng/i);
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('đơn đã thanh toán dùng trạng thái/thời điểm thật và không có nút thanh toán lần nữa', async ({ page }) => {
  const order = populatedOrder({ payment_method: 'ONLINE', status: 'Chờ giao hàng', payment_status: 'Đã thanh toán', approved_at: '2026-10-31T09:00:00.000Z', transaction_date: '2026-10-31T09:30:00.000Z' });
  const account = await mockMyOrders(page, { orders: [order] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-status')).toContainText('Chờ giao hàng');
  await expect(page.locator('.order-detail-payment-status')).toContainText('Đã thanh toán');
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('đơn hủy hiển thị riêng, không dựng thời điểm hủy hay tiến trình giao hàng đã hoàn tất', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder({ status: 'Đã hủy', payment_status: 'Đã hủy', note: 'Admin từ chối: khách yêu cầu địa chỉ ngoài vùng phục vụ.' })] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-cancelled')).toBeVisible();
  await expect(page.locator('.order-detail-status')).toContainText('Đã hủy');
  await expect(page.locator('.order-detail-payment-status')).toContainText('Đã hủy');
  await expect(detailPage(page)).toContainText('Admin từ chối: khách yêu cầu địa chỉ ngoài vùng phục vụ.');
  await expect(detailPage(page)).not.toContainText(/(?:Hủy lúc|Ngày hủy|Thời điểm hủy)\s*:?\s*\d/i);
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

test('tiến trình giao hàng không bịa ngày giờ chuyển trạng thái khi chưa có lịch sử', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder({ status: 'Đang giao hàng' })] });
  await page.goto('/my-orders/801');
  const progress = page.locator('.order-detail-progress');
  await expect(progress).toContainText('Đang giao hàng');
  await expect(progress).toContainText('Đã giao hàng');
  // Only order_date is known here. Delivery stages have no timestamp data.
  const times = await progress.locator('time').evaluateAll(nodes => nodes.map(node => node.getAttribute('datetime')));
  expect(times.every(value => value === '2026-10-31T08:15:00.000Z')).toBe(true);
  expect(times.length).toBeLessThanOrEqual(1);
  expectNoOrderMutations(account);
});

test('đơn bị từ chối hiển thị lý do Unicode và lịch sử thực tế sau khi tải lại', async ({ page }) => {
  const reason = 'Địa chỉ ngoài khu vực phục vụ.\nVui lòng kiểm tra lại địa chỉ nhận hàng. 🐾';
  const order = populatedOrder({ approval_state: 'pending', history: [] });
  const account = await mockMyOrders(page, { orders: [order] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-status')).toHaveText('Chờ duyệt');
  await expect(page.locator('.order-history-empty')).toBeVisible();
  Object.assign(order, {
    status: 'Đã hủy', payment_status: 'Đã hủy', approval_state: 'rejected', rejection_reason: reason,
    history: [{ history_id: 101, from_status: 'Chờ xử lý', to_status: 'Đã hủy', action: 'reject', actor_id: users.admin.user_id,
      actor_name: users.admin.full_name, created_at: '2026-10-31T10:30:00.000Z', reason }],
  });
  await page.reload();
  await expect(page.locator('.order-detail-status')).toHaveText('Đã từ chối');
  expect(await page.locator('.order-detail-rejection').textContent()).toContain(reason);
  await expect(page.locator('.order-detail-cancelled')).toContainText('Đơn hàng đã bị từ chối');
  await expect(page.locator('.order-history li')).toHaveCount(1);
  await expect(page.locator('.order-history')).toContainText('Chờ xử lý → Đã hủy');
  await expect(page.locator('.order-history')).toContainText(users.admin.full_name);
  expect(await page.locator('.order-history-reason').textContent()).toBe(reason);
  await expect(page.locator('.order-history time')).toHaveAttribute('datetime', '2026-10-31T10:30:00.000Z');
  expectNoOrderMutations(account);
});

test('Online đang chờ duyệt có bước duyệt riêng và sau duyệt mới chờ thanh toán', async ({ page }) => {
  const order = populatedOrder({ payment_method: 'ONLINE', status: 'Chờ thanh toán', approval_state: 'pending' });
  const account = await mockMyOrders(page, { orders: [order] });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-steps [aria-current="step"]')).toContainText('Chờ duyệt');
  await expect(page.locator('.order-detail-steps')).toContainText('Chờ thanh toán');
  Object.assign(order, { approved_at: '2026-10-31T10:00:00.000Z', approval_state: 'approved' });
  await page.reload();
  await expect(page.locator('.order-detail-status')).toHaveText('Chờ thanh toán');
  await expect(page.locator('.order-detail-steps [aria-current="step"]')).toContainText('Chờ thanh toán');
  await expect(page.locator('.order-detail-payment-status')).toHaveText('Chưa thanh toán');
  await noPaymentAction(page);
  expectNoOrderMutations(account);
});

for (const missing of [9901, 987654]) {
  test(`đổi URL sang ${missing === 9901 ? 'đơn tài khoản khác' : 'ID không tồn tại'} chỉ trả thông báo an toàn`, async ({ page }) => {
    const account = await mockMyOrders(page);
    await page.goto(`/my-orders/${missing}`);
    await expect(page.locator('.order-detail-not-found')).toContainText('Không tìm thấy đơn hàng hoặc bạn không có quyền truy cập.');
    await expect(page.locator('.order-detail-item')).toHaveCount(0);
    await expect(detailPage(page)).not.toContainText('Đơn riêng chỉ thuộc tài khoản B');
    expect(account.paymentReads).toEqual([]);
    expectNoOrderMutations(account);
  });
}

test('đăng nhập đúng tài khoản B xem được đơn B nhưng không đọc đơn A bằng đổi URL', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: 'b' });
  await page.goto('/my-orders/9901');
  await expect(detailPage(page)).toContainText('Đơn riêng chỉ thuộc tài khoản B');
  await page.goto('/my-orders/512');
  await expect(page.locator('.order-detail-not-found')).toBeVisible();
  await expect(detailPage(page)).not.toContainText('Sản phẩm đơn 512');
  expect(account.detailReads.every(read => read.token === tokenFor('b'))).toBe(true);
  expectNoOrderMutations(account);
});

for (const orderId of ['0', '-1', 'abc', '2147483648']) {
  test(`ID không hợp lệ ${orderId} không hiển thị dữ liệu đơn`, async ({ page }) => {
    const account = await mockMyOrders(page);
    await page.goto(`/my-orders/${orderId}`);
    await expect(page.locator('.order-detail-not-found, .order-detail-error')).toBeVisible();
    await expect(page.locator('.order-detail-item')).toHaveCount(0);
    expectNoOrderMutations(account);
  });
}

test('khách đăng nhập trở về chính URL chi tiết đã mở', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: null, orders: [populatedOrder()] });
  await page.goto('/my-orders/801');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders/801');
  expect(account.detailReads).toEqual([]);
  await loginForOrders(page, 'a', '/my-orders/801');
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  expectNoOrderMutations(account);
});

test('returnTo chi tiết được ưu tiên khi có Checkout đang chờ kết quả, giữ nguyên draft và idempotency key', async ({ page }) => {
  const pending = {
    version: 1, intent_id: 'order-detail-existing-checkout-intent', type: 'buy-now', user_id: users.a.user_id,
    items: [{ product_id: 1, quantity: 3 }],
    shipping: { recipient_name: 'Người nhận bản nháp', phone: '0987654321', address: '25 Đường Hoàng Sa\nThành phố Hồ Chí Minh', note: 'Giữ nguyên bản nháp này' },
    payment_method: 'COD', prices: { 1: '85000.00' }, order: null,
    submission: {
      key: '9aee9f64-f44b-4ae1-8b04-41e56bba1743',
      payload: {
        source: 'buy-now', items: [{ product_id: 1, quantity: 3 }], recipient_name: 'Người nhận bản nháp',
        phone: '0987654321', shipping_address: '25 Đường Hoàng Sa\nThành phố Hồ Chí Minh',
        note: 'Giữ nguyên bản nháp này', payment_method: 'COD',
      },
    },
  };
  await page.addInitScript(value => {
    if (sessionStorage.getItem('petcare.order-detail-pending-seeded')) return;
    sessionStorage.setItem('petcare.order-detail-pending-seeded', '1');
    sessionStorage.setItem('petcare.checkout-draft.v1', JSON.stringify(value));
  }, pending);
  const account = await mockMyOrders(page, { owner: null, orders: [populatedOrder()] });
  await page.goto('/my-orders/801');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await loginForOrders(page, 'a', '/my-orders/801');
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('petcare.checkout-draft.v1')))).toEqual(pending);
  expectNoOrderMutations(account);
});

test('đăng ký rồi đăng nhập vẫn giữ URL chi tiết', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: null, orders: [populatedOrder()] });
  await page.goto('/my-orders/801');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/register\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders/801');
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill(users.a.full_name);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(users.a.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('MyOrders-test-2026!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('MyOrders-test-2026!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders/801');
  await loginForOrders(page, 'a', '/my-orders/801');
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  expectNoOrderMutations(account);
});

for (const endpoint of ['detail', 'payment']) {
  test(`hết phiên khi đọc ${endpoint} phải đăng nhập lại rồi quay về cùng chi tiết`, async ({ page }) => {
    const failure = { status: 401, message: 'Invalid or expired token' };
    const account = await mockMyOrders(page, { orders: [populatedOrder()], ...(endpoint === 'detail' ? { detailFail: failure } : { paymentFail: failure }) });
    await page.goto('/my-orders/801');
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-orders/801');
    expect(await page.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
    await expect(page.locator('.order-detail-item')).toHaveCount(0);
    await loginForOrders(page, 'a', '/my-orders/801');
    await expect(page.locator('.order-detail-item')).toHaveCount(2);
    expectNoOrderMutations(account);
  });
}

test('đang tải chỉ hiện trạng thái chờ, nhận kết quả rồi mới hiển thị đơn', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder()], detailHold: true });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-loading')).toBeVisible();
  await expect(page.locator('.order-detail-item')).toHaveCount(0);
  account.releaseDetail();
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  await expect(page.locator('.order-detail-loading')).toHaveCount(0);
  expectNoOrderMutations(account);
});

for (const failure of [{ status: 500 }, { network: true }]) {
  test(`${failure.network ? 'lỗi kết nối' : 'lỗi Backend'} có Thử lại, không báo thành công hoặc dựng đơn giả`, async ({ page }) => {
    const account = await mockMyOrders(page, { orders: [populatedOrder()], detailFail: failure });
    await page.goto('/my-orders/801');
    await expect(page.locator('.order-detail-error')).toBeVisible();
    await expect(page.locator('.order-detail-item')).toHaveCount(0);
    await page.locator('.order-detail-error').getByRole('button', { name: /Thử lại/i }).click();
    await expect(page.locator('.order-detail-item')).toHaveCount(2);
    expect(account.detailReads.length).toBeGreaterThanOrEqual(2);
    expectNoOrderMutations(account);
  });
}

test('lỗi tải thông tin thanh toán vẫn giữ đơn và chỉ Thử lại GET thanh toán', async ({ page }) => {
  const account = await mockMyOrders(page, { orders: [populatedOrder()], paymentFail: { status: 500 } });
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  await page.locator('.order-detail-payment').getByRole('button', { name: /Thử lại/i }).click();
  await expect.poll(() => account.paymentReads.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.order-detail-payment').getByRole('button', { name: /Thử lại/i })).toHaveCount(0);
  await expect(page.locator('.order-detail-item')).toHaveCount(2);
  expect(account.detailReads).toHaveLength(1);
  expectNoOrderMutations(account);
});

test('response chi tiết sai chủ đơn bị chặn trước khi lộ thông tin', async ({ page }) => {
  const account = await mockMyOrders(page);
  await page.route(`${API}/api/orders/801`, route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { success: true, order: orderFixture(801, 'b', { recipient_name: 'NGƯỜI NHẬN BÍ MẬT CỦA B' }) },
  }));
  await page.goto('/my-orders/801');
  await expect(page.locator('.order-detail-error')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('NGƯỜI NHẬN BÍ MẬT CỦA B');
  await expect(page.locator('.order-detail-item')).toHaveCount(0);
  expect(account.paymentReads).toEqual([]);
  expectNoOrderMutations(account);
});

test('Admin không gọi API đơn khách hàng và giữ nguyên phiên', async ({ page }) => {
  const account = await mockMyOrders(page, { owner: 'admin' });
  await page.goto('/my-orders/801');
  await expect(detailPage(page)).toContainText('tài khoản khách hàng');
  expect(account.detailReads).toEqual([]);
  expect(account.paymentReads).toEqual([]);
  expect(await page.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY)).toBe(tokenFor('admin'));
  expectNoOrderMutations(account);
});

for (const pendingMerge of [false, true]) {
  test(`xem chi tiết khi còn giỏ khách ${pendingMerge ? 'và marker hợp nhất' : 'được chọn'} không tự hợp nhất hay sửa dữ liệu giỏ`, async ({ page }) => {
    const guest = { version: 1, items: [{ product_id: 1, quantity: 3, selected: true }, { product_id: 19, quantity: 2, selected: false }] };
    const marker = pendingMerge ? {
      key: '9e1df44e-a4d7-4cd4-920b-9a60d1be5de0', user_id: users.a.user_id, items: guest.items,
    } : null;
    const rawGuest = JSON.stringify(guest), rawMarker = marker && JSON.stringify(marker);
    await page.addInitScript(({ guestValue, markerValue }) => {
      if (sessionStorage.getItem('petcare.order-detail-guest-seeded')) return;
      sessionStorage.setItem('petcare.order-detail-guest-seeded', '1');
      localStorage.setItem('petcare.guest-cart.v1', guestValue);
      if (markerValue) localStorage.setItem('petcare.guest-merge.v1', markerValue);
    }, { guestValue: rawGuest, markerValue: rawMarker });
    const account = await mockMyOrders(page, { orders: [populatedOrder()] });
    await page.goto('/my-orders/801');
    await expect(page.locator('.order-detail-item')).toHaveCount(2);
    await expect.poll(() => account.paymentReads.length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator('.order-detail-item')).toHaveCount(2);
    expect(await page.evaluate(() => ({ guest: localStorage.getItem('petcare.guest-cart.v1'), marker: localStorage.getItem('petcare.guest-merge.v1') })))
      .toEqual({ guest: rawGuest, marker: rawMarker });
    expectNoOrderMutations(account);
  });
}

for (const width of [1440, 768, 390, 320]) {
  test(`chi tiết đơn responsive ${width}px với địa chỉ/tên dài, ảnh vừa khung`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const order = populatedOrder({
      recipient_name: 'Nguyễn Thị Ánh Hồng — Khách hàng nhận tại căn hộ',
      shipping_address: 'Căn hộ 1508, Tầng 15, Tòa Ánh Dương, số 123 đường Nguyễn Hữu Cảnh; cổng bên hông hướng đường nội bộ.\nPhường Thạnh Mỹ Tây, Thành phố Hồ Chí Minh.',
      note: 'Gọi trước khi giao.\nChỉ giao vào giờ hành chính và giữ nguyên bao bì. '.repeat(4),
    });
    order.items[0].name = 'Sản phẩm cho thú cưng với tên dài cần xuống dòng trên điện thoại '.repeat(5);
    order.items[1].image_url = '/images/products/not-found-for-order-detail.webp';
    const account = await mockMyOrders(page, { orders: [order] });
    await page.goto('/my-orders/801');
    await expect(page.locator('.order-detail-item')).toHaveCount(2);
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
    await expect(page.locator('.order-detail-shipping')).toContainText(order.recipient_name);
    await expect(page.locator('.order-detail-total')).toContainText(formatPrice(order.total_amount));
    const image = item(page, 1).locator('img');
    await expect(image).toBeVisible();
    expect(await image.evaluate(node => getComputedStyle(node).objectFit)).toBe('contain');
    expect(await detailPage(page).evaluate(element => [...element.querySelectorAll('.order-detail-item, .order-detail-shipping, .order-detail-total, button, img')].every(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }) && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if ([1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`order-detail-${width}.png`), fullPage: true });
    expectNoOrderMutations(account);
  });
}
