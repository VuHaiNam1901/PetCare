import { test, expect } from '@playwright/test';

const PRODUCTS = 'http://localhost:3000/api/products';

async function getRealProducts(request) {
  const response = await request.get(PRODUCTS);
  expect(response.ok(), 'Backend thật phải chạy ở cổng 3000').toBe(true);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.products.length).toBeGreaterThan(0);
  return body.products;
}

function selectProduct(products) {
  return products.find(product => Number(product.stock_quantity) > 1
    && products.some(other => other.category_id === product.category_id && other.product_id !== product.product_id))
    || products.find(product => Number(product.stock_quantity) > 1)
    || products[0];
}

async function expectDetail(page, product) {
  await expect(page).toHaveURL(new RegExp(`/products/${product.product_id}/?$`));
  await expect(page.locator('.product-detail-page').getByRole('heading', { level: 1, name: product.name, exact: true })).toBeVisible();
}

test('ảnh và tên từ trang chủ/danh sách mở đúng sản phẩm; thêm giỏ không điều hướng chi tiết', async ({ page }) => {
  for (const path of ['/', '/products']) {
    await page.goto(path);
    const card = page.locator('.product-card').filter({ has: page.locator('.buy-now:not(:disabled)') }).first();
    await expect(card).toBeVisible();
    const id = await card.getAttribute('data-product-id');
    const name = await card.locator('h3').innerText();
    const url = page.url();
    await card.locator('.add-to-cart').click();
    await expect(page.locator('.feature-notice')).toContainText(/Đã thêm|thêm.*thành công/i);
    expect(page.url()).toBe(url);
    await page.locator('.feature-notice button').click();
    await expect(card.locator('a.product-image-link')).toHaveAttribute('href', `/products/${id}`);
    await card.locator('a.product-image-link').click();
    await expectDetail(page, { product_id: id, name });
    await page.goBack();
    await expect(page.locator(`[data-product-id="${id}"] h3 a`)).toHaveAttribute('href', `/products/${id}`);
    await page.locator(`[data-product-id="${id}"] h3 a`).click();
    await expectDetail(page, { product_id: id, name });
  }
});

test('URL chi tiết trực tiếp và tải lại dùng dữ liệu thật, logo chung và sản phẩm cùng danh mục', async ({ page, request }, testInfo) => {
  const products = await getRealProducts(request);
  const product = selectProduct(products);
  const response = await page.goto(`/products/${product.product_id}`);
  expect(response.status()).toBe(200);
  await expectDetail(page, product);
  await expect(page.locator('.detail-price')).toHaveText(new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(product.price)));
  await expect(page.locator('.detail-stock')).toContainText(String(product.stock_quantity));
  await expect(page.locator('.product-detail-page')).toContainText(product.category_name);
  await expect(page.locator('.detail-description')).toContainText(product.description?.trim() || 'Mô tả sản phẩm đang được cập nhật.');
  const image = page.locator('.detail-image img');
  await expect(image).toHaveAttribute('alt', product.name);
  expect(await image.evaluate(async element => { await element.decode(); return element.naturalWidth > 0; })).toBe(true);
  await expect(page.locator('.site-header')).toHaveCount(1);
  await expect(page.locator('.site-footer')).toHaveCount(1);
  const logos = await page.locator('.logo-image').evaluateAll(images => images.map(element => element.currentSrc));
  expect(logos).toHaveLength(2);
  expect(new Set(logos).size).toBe(1);
  const relatedIds = await page.locator('.related-products .product-card').evaluateAll(cards => cards.map(card => Number(card.dataset.productId)));
  const expectedRelated = products.filter(other => other.product_id !== product.product_id && other.category_id === product.category_id);
  if (expectedRelated.length) expect(relatedIds.length).toBeGreaterThan(0);
  expect(relatedIds.every(id => expectedRelated.some(other => other.product_id === id))).toBe(true);
  expect(relatedIds).not.toContain(product.product_id);
  await page.reload();
  await expectDetail(page, product);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: testInfo.outputPath('product-detail-desktop.png'), fullPage: true });
  if (relatedIds.length) {
    const related = products.find(other => other.product_id === relatedIds[0]);
    await page.locator('.related-products .product-card h3 a').first().click();
    await expectDetail(page, related);
  }
});

test('số lượng mặc định 1, chỉ nhận số nguyên từ 1 tới tồn kho', async ({ page, request }) => {
  const products = await getRealProducts(request);
  const product = selectProduct(products);
  const stock = Number(product.stock_quantity);
  expect(stock).toBeGreaterThan(1);
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  const quantity = page.getByRole('spinbutton', { name: 'Số lượng', exact: true });
  await expect(quantity).toHaveValue('1');
  await expect(quantity).toHaveAttribute('min', '1');
  await expect(quantity).toHaveAttribute('max', String(stock));
  await expect(quantity).toHaveAttribute('step', '1');
  for (const [input, expected] of [['0', '1'], ['-2', '1'], [String(stock + 10), String(stock)], ['', '1']]) {
    await quantity.fill(input);
    await quantity.blur();
    await expect(quantity).toHaveValue(expected);
  }
  await quantity.fill('1.5');
  await quantity.blur();
  const value = Number(await quantity.inputValue());
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(1);
  expect(value).toBeLessThanOrEqual(stock);
  expect(await quantity.evaluate(element => element.checkValidity())).toBe(true);
});

test('hết hàng khóa số lượng/hai nút; thiếu mô tả và không có sản phẩm cùng danh mục không tạo nội dung giả', async ({ page, request }) => {
  const product = (await getRealProducts(request))[0];
  const fixture = { ...product, stock_quantity: 0, description: null };
  await page.route(PRODUCTS, route => route.fulfill({ json: { success: true, total: 1, products: [fixture] } }));
  await page.goto(`/products/${fixture.product_id}`);
  await expectDetail(page, fixture);
  await expect(page.getByRole('spinbutton', { name: 'Số lượng', exact: true })).toBeDisabled();
  await expect(page.locator('.detail-actions .add-to-cart')).toBeDisabled();
  await expect(page.locator('.detail-actions .buy-now')).toBeDisabled();
  await expect(page.locator('.detail-stock')).toContainText(/hết hàng/i);
  await expect(page.locator('.detail-description')).toContainText('Mô tả sản phẩm đang được cập nhật.');
  await expect(page.locator('.related-products .product-card')).toHaveCount(0);
});

test('chi tiết thêm đúng số lượng vào giỏ khách; mua ngay giữ giỏ và chuyển xác thực', async ({ page, request }) => {
  const product = selectProduct(await getRealProducts(request));
  const writes = [];
  page.on('request', req => { if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && new URL(req.url()).pathname !== '/api/cart/preview') writes.push(req.url()); });
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  const url = page.url();
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill('2');
  await page.locator('.detail-actions .add-to-cart').click();
  await expect(page.locator('.feature-notice')).toContainText(/Đã thêm|thêm.*thành công/i);
  expect(page.url()).toBe(url);
  await page.goto('/cart');
  await expect(page.locator(`[data-product-id="${product.product_id}"]`).getByRole('spinbutton')).toHaveValue('2');
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  await page.getByRole('spinbutton', { name: 'Số lượng', exact: true }).fill('3');
  await page.locator('.detail-actions .buy-now').click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await page.goto('/cart');
  await expect(page.locator(`[data-product-id="${product.product_id}"]`).getByRole('spinbutton')).toHaveValue('2');
  expect(writes).toEqual([]);
});

test('đang tải, lỗi và thử lại phân biệt với sản phẩm không tìm thấy hoặc ID không hợp lệ', async ({ page, request }) => {
  const products = await getRealProducts(request);
  const product = selectProduct(products);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  await page.route(PRODUCTS, async route => { await ready; await route.continue(); });
  try {
    await page.goto(`/products/${product.product_id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status', { name: 'Đang tải sản phẩm', exact: true })).toBeVisible();
  } finally { release(); }
  await expectDetail(page, product);
  await page.unroute(PRODUCTS);
  await page.route(PRODUCTS, route => route.fulfill({ status: 503, json: { success: false } }));
  await page.reload();
  const error = page.locator('.error-notice');
  await expect(error.getByRole('heading', { name: 'Chưa tải được sản phẩm', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Không tìm thấy sản phẩm', exact: true })).toHaveCount(0);
  await page.unroute(PRODUCTS);
  await error.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expectDetail(page, product);
  const missingId = Math.max(...products.map(item => Number(item.product_id))) + 1000;
  for (const id of [missingId, 'abc', '0', '-1']) {
    await page.goto(`/products/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Không tìm thấy sản phẩm', exact: true })).toBeVisible();
    await expect(page.locator('.detail-actions')).toHaveCount(0);
  }
  await page.route(PRODUCTS, route => route.fulfill({ json: { success: true, total: 0, products: [] } }));
  await page.goto(`/products/${product.product_id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Không tìm thấy sản phẩm', exact: true })).toBeVisible();
});

test('chi tiết responsive, điều hướng về danh sách/trang chủ hoạt động và không có lỗi JavaScript', async ({ page, request }, testInfo) => {
  const product = selectProduct(await getRealProducts(request));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const layout = await page.evaluate(() => ({
      noOverflow: document.documentElement.scrollWidth <= innerWidth,
      imageFits: document.querySelector('.detail-image').getBoundingClientRect().height <= Math.min(innerWidth, 600),
      actionsFit: [...document.querySelectorAll('.detail-actions button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && button.scrollWidth <= button.clientWidth;
      }),
    }));
    expect(layout, `Chi tiết ở ${width}px`).toEqual({ noOverflow: true, imageFits: true, actionsFit: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: testInfo.outputPath('product-detail-mobile.png'), fullPage: true });
  await page.locator('.detail-category a').click();
  await expect(page).toHaveURL(new RegExp(`/products\\?category=${product.category_id}$`));
  await expect(page.locator('.product-card').first()).toBeVisible();
  const categories = await page.locator('.product-card .product-category').allTextContents();
  expect(categories.every(name => name === product.category_name)).toBe(true);
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  const search = page.getByRole('searchbox', { name: 'Tìm kiếm sản phẩm' });
  await search.fill(product.name);
  await search.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Danh sách sản phẩm', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('q')).toBe(product.name);
  await expect(page.locator(`[data-product-id="${product.product_id}"]`)).toBeVisible();
  await page.goto(`/products/${product.product_id}`);
  await expectDetail(page, product);
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' }).getByRole('link', { name: 'Sản phẩm', exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Danh sách sản phẩm', exact: true })).toBeVisible();
  await page.locator('.site-header .logo').click();
  await expect(page.locator('#hero-title')).toBeVisible();
  expect(errors).toEqual([]);
});
