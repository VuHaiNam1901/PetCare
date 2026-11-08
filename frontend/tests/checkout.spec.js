import { test, expect } from '@playwright/test';
import { API, formatPrice, catalogProducts, checkoutAccount, loginAccount, seedGuest, beginAccountCheckout, expectNoOrderWrites } from './helpers/checkout-fixtures.js';

const item = (page, product) => page.locator(`.checkout-item[data-product-id="${product.product_id}"]`);
const draft = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('petcare.checkout-draft.v1')));
const confirm = page => page.getByRole('button', { name: 'Xác nhận đặt hàng', exact: true });
const validated = page => page.locator('.checkout-confirmation');
const shippingFields = page => ({
  name: page.locator('#checkout-recipient_name'),
  phone: page.locator('#checkout-phone'),
  address: page.locator('#checkout-address'),
  note: page.locator('#checkout-note'),
});

test('giỏ đã đăng nhập chỉ đưa các dòng đã chọn sang checkout, giữ nguyên toàn bộ giỏ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [first, second, unselected] = products;
  const original = [
    { product_id: first.product_id, quantity: 2, selected: true },
    { product_id: second.product_id, quantity: 3, selected: true },
    { product_id: unselected.product_id, quantity: 7, selected: false },
  ];
  const account = await beginAccountCheckout(page, products, original);
  await expect(page.locator('.checkout-item')).toHaveCount(2);
  await expect(item(page, first)).toContainText(first.name);
  await expect(item(page, second)).toContainText(second.name);
  await expect(item(page, unselected)).toHaveCount(0);
  const total = Number(first.price) * 2 + Number(second.price) * 3;
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(total));
  await expect(page.locator('.checkout-total')).toHaveText(formatPrice(total));
  expect((await draft(page)).items).toEqual(original.filter(row => row.selected).map(({ product_id, quantity }) => ({ product_id, quantity })));
  expect(account.cart().items.map(({ product_id, quantity, selected }) => ({ product_id, quantity, selected }))).toEqual(original);
  expectNoOrderWrites(account);
});

test('Mua ngay dùng đúng sản phẩm và số lượng riêng, không thêm vào hay thay đổi giỏ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [cartProduct, buyProduct] = products;
  const original = [{ product_id: cartProduct.product_id, quantity: 2, selected: true }];
  const account = await checkoutAccount(page, products, original);
  await page.goto('/login');
  await loginAccount(page);
  await page.goto(`/products/${buyProduct.product_id}`);
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill('3');
  await page.locator('.detail-actions .buy-now').click();
  await expect(page).toHaveURL(/\/checkout(?:\?.*)?$/);
  await expect(page.locator('.checkout-item')).toHaveCount(1);
  await expect(item(page, buyProduct)).toContainText(buyProduct.name);
  await expect(item(page, cartProduct)).toHaveCount(0);
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(Number(buyProduct.price) * 3));
  expect((await draft(page)).type).toBe('buy-now');
  expect((await draft(page)).items).toEqual([{ product_id: buyProduct.product_id, quantity: 3 }]);
  expect(account.cart().items.map(({ product_id, quantity, selected }) => ({ product_id, quantity, selected }))).toEqual(original);
  expectNoOrderWrites(account);
});

test('khách đăng ký/đăng nhập rồi đồng bộ giỏ tiếp tục checkout với đúng số lượng định đặt', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [first, guestOnly, accountOnly] = products;
  const account = await checkoutAccount(page, products, [
    { product_id: first.product_id, quantity: 2, selected: true },
    { product_id: accountOnly.product_id, quantity: 1, selected: true },
  ]);
  await seedGuest(page, [
    { product_id: first.product_id, quantity: 3, selected: true },
    { product_id: guestOnly.product_id, quantity: 1, selected: false },
  ]);
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/login\?flow=/);
  const flow = new URL(page.url()).searchParams.get('flow');
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/\/register\?flow=/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(flow);
  await page.getByRole('textbox', { name: 'Họ và tên', exact: true }).fill('Nguyễn Khách Hàng');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('checkout-ui@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('CheckoutUiOnly123!');
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill('CheckoutUiOnly123!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('flow')).toBe(flow);
  await loginAccount(page, /\/checkout(?:\?.*)?$/);
  await expect(page.locator('.checkout-item')).toHaveCount(1);
  await expect(item(page, first)).toContainText(first.name);
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(Number(first.price) * 3));
  expect((await draft(page)).items).toEqual([{ product_id: first.product_id, quantity: 3 }]);
  expect(account.cart().items.find(row => row.product_id === first.product_id).quantity).toBe(5);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth-redirect.v1'))).toBeNull();
  expectNoOrderWrites(account);
});

test('checkout điền sẵn hồ sơ, giữ form và sản phẩm sau tải lại; đăng xuất xóa bản nháp', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 2, selected: true }]);
  const fields = shippingFields(page);
  await expect(fields.name).toHaveValue(account.user.full_name);
  await expect(fields.phone).toHaveValue(account.user.phone);
  await expect(fields.address).toHaveValue(account.user.address);
  await fields.name.fill('Người nhận khác');
  await fields.phone.fill('0912345678');
  await fields.address.fill('456 Lê Lợi, Phường Bến Thành, TP Hồ Chí Minh');
  await fields.note.fill('Gọi điện trước khi giao hàng');
  await page.getByRole('radio', { name: 'Thanh toán online (mô phỏng)', exact: true }).check();
  await page.reload();
  await expect(fields.name).toHaveValue('Người nhận khác');
  await expect(fields.phone).toHaveValue('0912345678');
  await expect(fields.address).toHaveValue('456 Lê Lợi, Phường Bến Thành, TP Hồ Chí Minh');
  await expect(fields.note).toHaveValue('Gọi điện trước khi giao hàng');
  await expect(page.getByRole('radio', { name: 'Thanh toán online (mô phỏng)', exact: true })).toBeChecked();
  await expect(item(page, product)).toBeVisible();
  expect((await draft(page)).items).toEqual([{ product_id: product.product_id, quantity: 2 }]);
  expectNoOrderWrites(account);
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.checkout-draft.v1'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('petcare.auth.token.v1'))).toBeNull();
  await loginAccount(page);
  await expect(page.locator('#hero-title')).toBeVisible();
  expect(account.cart().items[0].quantity).toBe(2);
});

test('ý định ở tab khác không thay thế bản nháp sản phẩm đang đăng nhập của tab hiện tại', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [original, other] = products;
  const account = await checkoutAccount(page, products);
  await seedGuest(page, [
    { product_id: original.product_id, quantity: 3, selected: true },
    { product_id: other.product_id, quantity: 1, selected: false },
  ]);
  await page.locator('.cart-checkout').click();
  await expect(page).toHaveURL(/\/login\?flow=/);
  await page.evaluate(productId => localStorage.setItem('petcare.checkout-intent.v1', JSON.stringify({
    version: 1, id: 'purchase-from-another-tab', type: 'buy-now', product_id: productId,
    quantity: 1, product_ids: [productId], items: [{ product_id: productId, quantity: 1 }], authenticated: false, created_at: Date.now(),
  })), other.product_id);
  await loginAccount(page, /\/checkout(?:\?.*)?$/);
  await expect(page.locator('.checkout-item')).toHaveCount(1);
  await expect(item(page, original)).toContainText(original.name);
  await expect(item(page, other)).toHaveCount(0);
  expect((await draft(page)).items).toEqual([{ product_id: original.product_id, quantity: 3 }]);
  expect((await draft(page)).user_id).toBe(account.user.user_id);
  expectNoOrderWrites(account);
});

test('phiên hết hạn trong checkout: đăng nhập lại giữ form và đúng các sản phẩm định đặt', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 2, selected: true }]);
  const fields = shippingFields(page);
  await fields.name.fill('Tên người nhận đã sửa');
  await fields.note.fill('Giữ ghi chú sau khi đăng nhập lại');
  account.expireMe();
  await page.reload();
  await expect(page).toHaveURL(/\/login\?flow=/);
  await loginAccount(page, /\/checkout(?:\?.*)?$/);
  await expect(fields.name).toHaveValue('Tên người nhận đã sửa');
  await expect(fields.note).toHaveValue('Giữ ghi chú sau khi đăng nhập lại');
  await expect(item(page, product)).toBeVisible();
  expect((await draft(page)).items).toEqual([{ product_id: product.product_id, quantity: 2 }]);
  expect(account.cart().items[0].quantity).toBe(2);
  expectNoOrderWrites(account);
});

test('mở checkout không có sản phẩm định đặt hiển thị hướng dẫn chọn hàng, không tự lấy cả giỏ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await checkoutAccount(page, products, [{ product_id: product.product_id, quantity: 2, selected: true }]);
  await page.goto('/login');
  await loginAccount(page);
  await page.goto('/checkout');
  await expect(page.locator('.checkout-page')).toContainText(/chọn sản phẩm|chưa có sản phẩm|chưa chọn sản phẩm/i);
  await expect(page.locator('.checkout-item')).toHaveCount(0);
  await expect(confirm(page)).toHaveCount(0);
  expect(account.cart().items[0].quantity).toBe(2);
  expectNoOrderWrites(account);
});

test('khách mở trực tiếp checkout trống được hướng dẫn chọn hàng, không mắc ở màn hình chờ', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const account = await checkoutAccount(page, products);
  await page.goto('/checkout');
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator('.checkout-page')).toContainText(/chọn sản phẩm|chưa có sản phẩm|chưa chọn sản phẩm/i);
  await expect(page.locator('.checkout-item')).toHaveCount(0);
  await expect(confirm(page)).toHaveCount(0);
  await expect(page.locator('.checkout-state').getByRole('link', { name: 'Xem sản phẩm', exact: true })).toBeVisible();
  expectNoOrderWrites(account);
});

test('kiểm tra thông tin nhận hàng và chỉ thông báo sau khi nhận mã đơn COD', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 2, selected: true }]);
  const fields = shippingFields(page);
  await expect(page.locator('.checkout-shipping')).toContainText('Chưa xác định');
  await expect(page.locator('.checkout-shipping')).not.toContainText(/miễn phí|^0\s*₫$/i);
  await expect(page.locator('.checkout-page')).toContainText('Tiền hàng chưa gồm vận chuyển');
  await expect(page.getByRole('radio', { name: 'Thanh toán khi nhận hàng (COD)', exact: true })).toBeChecked();
  await fields.name.fill('');
  await fields.phone.fill('abc123');
  await fields.address.fill('');
  await confirm(page).click();
  await expect(validated(page)).toHaveCount(0);
  await expect(fields.name).toHaveAttribute('aria-invalid', 'true');
  await expect(fields.phone).toHaveAttribute('aria-invalid', 'true');
  await expect(fields.address).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.checkout-field-error').filter({ hasText: /điện thoại.*hợp lệ/i })).toBeVisible();
  await fields.name.fill('Nguyễn Văn A');
  await fields.address.fill('789 Trần Hưng Đạo, Quận 1, TP Hồ Chí Minh');
  await fields.phone.fill('123');
  await confirm(page).click();
  await expect(validated(page)).toHaveCount(0);
  await fields.phone.fill('0987654321');
  await confirm(page).click();
  await expect(validated(page)).toContainText(String(account.orders[0]?.order_id || 7001));
  await expect(page.locator('.checkout-total')).toHaveText(formatPrice(Number(product.price) * 2));
  expect(account.cart().items).toEqual([]);
  expect(account.orderWrites()).toHaveLength(1);
  expect(account.orders[0].payment_method).toBe('COD');
  expect(account.orders[0].payment_status).toBe('Chưa thanh toán');
  expect(account.unexpected).toEqual([]);
});

test('giá lưu trong trình duyệt không quyết định tổng tiền; xác nhận kiểm tra giá mới từ API', async ({ page, request }) => {
  const products = await catalogProducts(request);
  const [product] = products;
  const account = await beginAccountCheckout(page, products, [{ product_id: product.product_id, quantity: 2, selected: true }]);
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(Number(product.price) * 2));
  await page.evaluate(id => {
    const key = 'petcare.checkout-draft.v1';
    const value = JSON.parse(sessionStorage.getItem(key));
    value.prices = { ...value.prices, [id]: '1.00' };
    sessionStorage.setItem(key, JSON.stringify(value));
  }, product.product_id);
  await page.reload();
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(Number(product.price) * 2));
  await expect(page.locator('.checkout-price-notice')).toBeVisible();
  const updatedPrice = Number(product.price) + 12345;
  account.updateProduct(product.product_id, { price: updatedPrice.toFixed(2) });
  await page.route(`${API}/api/cart/preview`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.cart.items) if (row.product_id === product.product_id) {
      row.price = updatedPrice.toFixed(2);
      row.line_total = (updatedPrice * row.quantity).toFixed(2);
    }
    await route.fulfill({ response, json: body });
  });
  await confirm(page).click();
  await expect(page.locator('.checkout-price-notice')).toBeVisible();
  await expect(page.locator('.checkout-subtotal')).toHaveText(formatPrice(updatedPrice * 2));
  await expect(page.locator('.checkout-total')).toHaveText(formatPrice(updatedPrice * 2));
  await expect(validated(page)).toHaveCount(0);
  await confirm(page).click();
  await expect(validated(page)).toBeVisible();
  expect(account.orderWrites()).toHaveLength(1);
  expect(account.orders[0].total_amount).toBe((updatedPrice * 2).toFixed(2));
  expect(account.unexpected).toEqual([]);
});

for (const state of ['missing', 'invalid-price', 'stopped', 'out-of-stock', 'insufficient']) {
  test(`checkout chặn sản phẩm ${state}, giữ mọi dòng thay vì tự bỏ sản phẩm`, async ({ page, request }) => {
    const products = await catalogProducts(request);
    const [problem, valid] = products;
    const account = await beginAccountCheckout(page, products, [
      { product_id: problem.product_id, quantity: 3, selected: true },
      { product_id: valid.product_id, quantity: 1, selected: true },
    ]);
    await expect(page.locator('.checkout-item')).toHaveCount(2);
    await page.route(`${API}/api/cart/preview`, async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (state === 'missing') body.cart.items = body.cart.items.filter(row => row.product_id !== problem.product_id);
      else {
        const row = body.cart.items.find(candidate => candidate.product_id === problem.product_id);
        if (state === 'invalid-price') { row.price = 'not-a-price'; row.line_total = null; }
        else {
          row.available = false;
          row.availability_message = state === 'stopped' ? 'Sản phẩm hiện đã ngừng bán' : state === 'out-of-stock' ? 'Sản phẩm đã hết hàng' : 'Số lượng vượt tồn kho hiện tại';
          if (state === 'stopped') row.status = 'Ngừng bán';
          else row.stock_quantity = state === 'out-of-stock' ? 0 : 1;
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator('.checkout-item')).toHaveCount(2);
    await expect(item(page, valid)).toContainText(valid.name);
    await expect(item(page, problem)).toBeVisible();
    await expect(item(page, problem).locator('.checkout-item-error')).toBeVisible();
    if (['missing', 'invalid-price'].includes(state)) await expect(page.locator('.checkout-total')).toHaveText('Chưa xác định');
    await expect(confirm(page)).toBeDisabled();
    await expect(validated(page)).toHaveCount(0);
    expect((await draft(page)).items).toEqual([{ product_id: problem.product_id, quantity: 3 }, { product_id: valid.product_id, quantity: 1 }]);
    expectNoOrderWrites(account);
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
  test(`checkout responsive ${viewport.width}×${viewport.height}, mọi ảnh và trường nhập nằm trong khung`, async ({ page, request }, testInfo) => {
    await page.setViewportSize(viewport);
    const products = await catalogProducts(request);
    const bottle = products.find(product => /SHED-X.*473ml/i.test(product.name));
    expect(bottle).toBeDefined();
    const account = await beginAccountCheckout(page, products, [{ product_id: bottle.product_id, quantity: 2, selected: true }]);
    await expect(item(page, bottle)).toBeVisible();
    const image = item(page, bottle).locator('img');
    await image.evaluate(element => element.decode());
    const fits = await page.locator('.checkout-page').evaluate(element => {
      const viewportWidth = innerWidth;
      return [...element.querySelectorAll('input, textarea, button, .checkout-item, .checkout-item img')].every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= 0 && box.right <= viewportWidth;
      }) && document.documentElement.scrollWidth <= viewportWidth;
    });
    expect(fits).toBe(true);
    const columns = await page.locator('.checkout-layout').evaluate(element => {
      const main = element.querySelector('.checkout-main').getBoundingClientRect();
      const summary = element.querySelector('.checkout-summary').getBoundingClientRect();
      return { mainRight: main.right, mainBottom: main.bottom, summaryLeft: summary.left, summaryTop: summary.top };
    });
    if (viewport.width >= 1366) expect(columns.summaryLeft).toBeGreaterThan(columns.mainRight);
    else expect(columns.summaryTop).toBeGreaterThan(columns.mainBottom);
    await expect(image).toHaveCSS('object-fit', 'contain');
    await page.screenshot({ path: testInfo.outputPath('checkout.png'), fullPage: true });
    expectNoOrderWrites(account);
  });
}
