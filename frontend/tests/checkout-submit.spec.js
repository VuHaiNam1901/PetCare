import { test, expect } from '@playwright/test';
import { API, catalogProducts, checkoutAccount, loginAccount, seedGuest, beginAccountCheckout, formatPrice } from './helpers/checkout-fixtures.js';

const submit = page => page.locator('.checkout-submit');
const receipt = page => page.locator('.checkout-confirmation');
const draft = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('petcare.checkout-draft.v1')));
const ready = async page => expect(submit(page)).toBeEnabled();

test('COD đặt đúng snapshot sau hợp nhất, chỉ giảm số lượng đã mua và gửi thông tin nhận hàng', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product, unselected] = products;
  const account = await checkoutAccount(page, products, [
    { product_id: product.product_id, quantity: 2, selected: true },
    { product_id: unselected.product_id, quantity: 4, selected: false },
  ]);
  await seedGuest(page, [{ product_id: product.product_id, quantity: 3, selected: true }]);
  await page.locator('.cart-checkout').click();
  await loginAccount(page, /\/checkout$/);
  await ready(page);
  await page.locator('#checkout-recipient_name').fill('Người nhận riêng');
  await page.locator('#checkout-phone').fill('0912345678');
  await page.locator('#checkout-address').fill('123 Nguyễn Trãi\nPhường Bến Thành, TP Hồ Chí Minh');
  await page.locator('#checkout-note').fill('Gọi trước khi giao\nKhông giao buổi trưa');
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()).toHaveLength(1);
  expect(account.orderWrites()[0].body).toEqual({
    source: 'cart', items: [{ product_id: product.product_id, quantity: 3 }],
    recipient_name: 'Người nhận riêng', phone: '0912345678',
    shipping_address: '123 Nguyễn Trãi\nPhường Bến Thành, TP Hồ Chí Minh',
    note: 'Gọi trước khi giao\nKhông giao buổi trưa', payment_method: 'COD',
  });
  expect(account.orderWrites()[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect(account.orderWrites()[0].authorization).toBe('Bearer checkout-ui-token');
  expect(account.cart().items.find(item => item.product_id === product.product_id).quantity).toBe(2);
  expect(account.cart().items.find(item => item.product_id === unselected.product_id).quantity).toBe(4);
  expect(account.orders[0].total_amount).toBe((Number(product.price) * 3).toFixed(2));
  await expect(page.locator('.checkout-total')).toHaveText(formatPrice(Number(product.price) * 3));
  expect(account.unexpected).toEqual([]);
});

test('Mua ngay tạo đơn riêng và giữ nguyên giỏ kể cả khi sản phẩm đã nằm trong giỏ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const original = [{ product_id: product.product_id, quantity: 5, selected: true }];
  const account = await checkoutAccount(page, products, original);
  await page.goto('/login');
  await loginAccount(page);
  await page.goto(`/products/${product.product_id}`);
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill('3');
  await page.locator('.detail-actions .buy-now').click();
  await ready(page);
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()[0].body.source).toBe('buy-now');
  expect(account.orderWrites()[0].body.items).toEqual([{ product_id: product.product_id, quantity: 3 }]);
  expect(account.cart().items.map(({ product_id, quantity, selected }) => ({ product_id, quantity, selected }))).toEqual(original);
  expect(account.unexpected).toEqual([]);
});

test('double click chờ phản hồi commit và chỉ tạo một đơn; tải lại không gửi lại', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await beginAccountCheckout(page, products, [{ product_id: products[0].product_id, quantity: 2, selected: true }]);
  await ready(page);
  account.delayOrder(700);
  await submit(page).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => account.orderWrites().length).toBe(1);
  await expect(submit(page)).toBeDisabled();
  await expect(receipt(page)).toHaveCount(0);
  await expect(receipt(page)).toContainText('7001');
  expect(account.orders).toHaveLength(1);
  await page.reload();
  await expect(receipt(page)).toContainText('7001');
  await expect(submit(page)).toBeDisabled();
  expect(account.orderWrites()).toHaveLength(1);
});

test('mất phản hồi sau commit: catalog hết hàng vẫn replay cùng key sau reload, không tạo đơn thứ hai', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await beginAccountCheckout(page, products, [{ product_id: products[0].product_id, quantity: 2, selected: true }]);
  await ready(page);
  account.loseOrderResponse();
  await submit(page).click();
  await expect.poll(() => account.orderWrites().length).toBe(1);
  await expect(page.locator('.checkout-page')).toContainText(/thử lại|kết nối/i);
  await expect(receipt(page)).toHaveCount(0);
  const pending = (await draft(page)).submission;
  expect(pending.key).toBe(account.orderWrites()[0].key);
  // Stock/cart may already be consumed by the first commit. Replaying the saved
  // request must not be blocked by a new preview of that exhausted stock.
  let previewCalls = 0;
  await page.route(`${API}/api/cart/preview`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    previewCalls++;
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { success: true, cart: { items: [{ ...products[0], quantity: 2, stock_quantity: 0, available: false, availability_message: 'Sản phẩm đã hết hàng' }] } } });
  });
  await page.reload();
  await expect(submit(page)).toContainText(/thử lại/i);
  await expect(page.locator('#checkout-recipient_name')).toBeDisabled();
  // The pending page may refresh its read-only display on mount. Exhausted
  // stock must remain visible while retry itself bypasses catalog validation.
  await expect(page.locator('.checkout-item-error')).toContainText('hết hàng');
  expect(previewCalls).toBeGreaterThan(0);
  previewCalls = 0;
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()).toHaveLength(2);
  expect(account.orderWrites()[1].key).toBe(account.orderWrites()[0].key);
  expect(account.orderWrites()[1].body).toEqual(account.orderWrites()[0].body);
  expect(account.orders).toHaveLength(1);
  expect(account.cart().items).toEqual([]);
  await page.reload();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()).toHaveLength(2);
  expect(previewCalls).toBe(0);
});

test('401 ngay lúc đặt hàng: đăng nhập lại quay về Checkout, giữ thông tin và retry cùng key', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 3, selected: true }]);
  await ready(page);
  await page.locator('#checkout-recipient_name').fill('Người nhận sau đăng nhập lại');
  await page.locator('#checkout-note').fill('Giữ ghi chú và số lượng');
  account.expireMe();
  await submit(page).click();
  await expect(page).toHaveURL(/\/login\?flow=/);
  await expect(receipt(page)).toHaveCount(0);
  expect(account.orders).toHaveLength(0);
  expect((await draft(page)).items).toEqual([{ product_id: product.product_id, quantity: 3 }]);
  await loginAccount(page, /\/checkout$/);
  await expect(page.locator('#checkout-recipient_name')).toHaveValue('Người nhận sau đăng nhập lại');
  await expect(page.locator('#checkout-note')).toHaveValue('Giữ ghi chú và số lượng');
  await ready(page);
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()).toHaveLength(2);
  expect(account.orderWrites()[1].key).toBe(account.orderWrites()[0].key);
  expect(account.orderWrites()[1].body).toEqual(account.orderWrites()[0].body);
  expect(account.orders).toHaveLength(1);
});

test('mất phản hồi rồi đăng xuất và đăng nhập thường vẫn replay đơn cũ bằng đúng key', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await beginAccountCheckout(page, products, [{ product_id: products[0].product_id, quantity: 2, selected: true }]);
  await ready(page);
  await page.locator('#checkout-note').fill('Giữ lần đặt hàng chưa nhận được kết quả');
  account.loseOrderResponse();
  await submit(page).click();
  await expect.poll(() => account.orderWrites().length).toBe(1);
  await expect(submit(page)).toContainText(/thử lại/i);
  await expect(submit(page)).toBeEnabled();
  const pending = (await draft(page)).submission;
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await draft(page)).submission).toEqual(pending);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeNull();
  await page.goto('/');
  await page.locator('.site-header .account-action').click();
  await expect(page).toHaveURL(/\/login$/);
  await loginAccount(page, /\/checkout$/);
  await expect(page.locator('#checkout-note')).toHaveValue('Giữ lần đặt hàng chưa nhận được kết quả');
  expect((await draft(page)).submission).toEqual(pending);
  await ready(page);
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()).toHaveLength(2);
  expect(account.orderWrites()[1].key).toBe(pending.key);
  expect(account.orderWrites()[1].body).toEqual(pending.payload);
  expect(account.orders).toHaveLength(1);
  expect(account.cart().items).toEqual([]);
});

test('flow mua hàng quá 30 phút vẫn giữ form và sản phẩm qua đăng ký rồi đăng nhập', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 3, selected: true }]);
  await ready(page);
  await page.locator('#checkout-recipient_name').fill('Người nhận giữ qua flow hết hạn');
  await page.locator('#checkout-note').fill('Không mất nội dung sau ba mươi phút');
  account.expireMe();
  await page.reload();
  await expect(page).toHaveURL(/\/login\?flow=/);
  const originalFlow = new URL(page.url()).searchParams.get('flow');
  await page.evaluate(() => {
    const key = 'petcare.auth-redirect.v1';
    const flow = JSON.parse(sessionStorage.getItem(key));
    flow.created_at = Date.now() - 31 * 60 * 1000;
    sessionStorage.setItem(key, JSON.stringify(flow));
  });
  await page.reload();
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/register\?flow=/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(originalFlow);
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill('Nguyễn Khách Hàng');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('checkout-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CheckoutUiOnly123!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('CheckoutUiOnly123!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?flow=/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(originalFlow);
  await loginAccount(page, /\/checkout$/);
  await expect(page.locator('#checkout-recipient_name')).toHaveValue('Người nhận giữ qua flow hết hạn');
  await expect(page.locator('#checkout-note')).toHaveValue('Không mất nội dung sau ba mươi phút');
  expect((await draft(page)).items).toEqual([{ product_id: product.product_id, quantity: 3 }]);
  expect(account.orderWrites()).toHaveLength(0);
  expect(account.orders).toHaveLength(0);
});

test('API từ chối thiếu tồn kho không báo thành công và không đổi giỏ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const original = [{ product_id: products[0].product_id, quantity: 2, selected: true }];
  const account = await beginAccountCheckout(page, products, original);
  await ready(page);
  account.failNextOrder(409, 'Insufficient stock or invalid cart quantity');
  await submit(page).click();
  await expect(page.getByRole('alert')).toContainText(/tồn kho|Insufficient stock/i);
  await expect(receipt(page)).toHaveCount(0);
  expect(account.orders).toHaveLength(0);
  expect(account.cart().items[0].quantity).toBe(2);
});

test('lỗi server không báo thành công; retry cùng key hoàn tất một đơn', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await beginAccountCheckout(page, products, [{ product_id: products[0].product_id, quantity: 2, selected: true }]);
  await ready(page);
  account.failNextOrder(500, 'Temporary database failure');
  await submit(page).click();
  await expect(page.getByRole('alert')).toContainText(/Temporary database failure/);
  await expect(receipt(page)).toHaveCount(0);
  const key = account.orderWrites()[0].key;
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  expect(account.orderWrites()[1].key).toBe(key);
  expect(account.orders).toHaveLength(1);
});

test('ONLINE tạo đơn chưa thanh toán và chờ Admin duyệt, không gọi mô phỏng', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await beginAccountCheckout(page, products, [{ product_id: products[0].product_id, quantity: 2, selected: true }]);
  await ready(page);
  await page.getByRole('radio', { name: 'Thanh toán online (mô phỏng)', exact: true }).check();
  await submit(page).click();
  await expect(receipt(page)).toContainText('7001');
  await expect(receipt(page)).toContainText(/duyệt|xác nhận/i);
  expect(account.orders[0]).toMatchObject({ payment_method: 'ONLINE', payment_status: 'Chưa thanh toán', status: 'Chờ thanh toán', approved_at: null });
  expect(account.writes.filter(write => write.path.includes('/payment'))).toEqual([]);
  expect(account.unexpected).toEqual([]);
});
