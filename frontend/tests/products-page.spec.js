import { test, expect } from '@playwright/test';

const PRODUCTS = 'http://localhost:3000/api/products';
const CATEGORIES = 'http://localhost:3000/api/categories';
const PAGE_SIZE = 8;
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
const shortCategoryName = name => name.replace(/ thú cưng$/i, '').replace('Vệ sinh và chăm sóc', 'Vệ sinh').replace('Dinh dưỡng bổ sung', 'Dinh dưỡng');

async function getRealData(request) {
  const responses = await Promise.all([request.get(PRODUCTS), request.get(CATEGORIES)]);
  for (const response of responses) expect(response.ok(), 'Backend thật phải chạy ở cổng 3000').toBe(true);
  const [productBody, categoryBody] = await Promise.all(responses.map(response => response.json()));
  expect(productBody.success).toBe(true);
  expect(categoryBody.success).toBe(true);
  return { products: productBody.products, categories: categoryBody.categories };
}

async function waitForListing(page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Danh sách sản phẩm', exact: true })).toBeVisible();
  await expect(page.locator('.product-card').first()).toBeVisible();
}

async function shownProducts(page, products) {
  const ids = await page.locator('.product-card').evaluateAll(cards => cards.map(card => card.dataset.productId));
  return ids.map(id => products.find(product => String(product.product_id) === id));
}

test('menu và Xem tất cả mở /products; URL trực tiếp, tải lại và điều hướng mobile hoạt động', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#hero-title')).toBeVisible();
  await page.locator('.desktop-nav').getByRole('link', { name: 'Sản phẩm', exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await waitForListing(page);
  await expect(page.locator('#hero-title')).toHaveCount(0);
  await expect(page.locator('.site-header')).toHaveCount(1);
  await expect(page.locator('.site-footer')).toHaveCount(1);
  const logos = await page.locator('.logo-image').evaluateAll(async images => {
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => image.currentSrc);
  });
  expect(logos).toHaveLength(2);
  expect(new Set(logos).size).toBe(1);
  await page.reload();
  await expect(page).toHaveURL(/\/products$/);
  await waitForListing(page);
  await page.locator('.site-header .logo').click();
  await expect(page.locator('#hero-title')).toBeVisible();
  await page.locator('.products-section').getByRole('link', { name: 'Xem tất cả', exact: true }).click();
  await waitForListing(page);
  await page.goBack();
  await expect(page.locator('#hero-title')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' }).getByRole('link', { name: 'Sản phẩm', exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await waitForListing(page);
  await expect(page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' })).toHaveCount(0);
  const response = await page.goto('/products');
  expect(response.status()).toBe(200);
  await waitForListing(page);
});

test('tìm kiếm không dấu kết hợp danh mục và sắp xếp hai chiều, đếm kết quả và xóa bộ lọc', async ({ page, request }) => {
  const { products, categories } = await getRealData(request);
  const category = [...categories].sort((a, b) => products.filter(p => p.category_id === b.category_id).length - products.filter(p => p.category_id === a.category_id).length)[0];
  const selected = products.filter(product => String(product.category_id) === String(category.category_id));
  expect(selected.length).toBeGreaterThan(1);
  await page.goto('/products');
  await waitForListing(page);
  await page.locator('.catalog-filter').getByRole('button', { name: shortCategoryName(category.name), exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Tìm kiếm sản phẩm' });
  await search.fill(normalize(category.name));
  const sort = page.getByRole('combobox', { name: 'Sắp xếp sản phẩm' });
  for (const direction of ['price-asc', 'price-desc']) {
    await sort.selectOption(direction);
    await expect(page.locator('.product-card')).toHaveCount(Math.min(PAGE_SIZE, selected.length));
    await expect(page.locator('.catalog-summary')).toContainText(`/ ${selected.length} sản phẩm`);
    const shown = await shownProducts(page, products);
    expect(shown.every(product => String(product.category_id) === String(category.category_id))).toBe(true);
    const expectedPrices = selected.map(product => Number(product.price)).sort((a, b) => direction === 'price-asc' ? a - b : b - a).slice(0, PAGE_SIZE);
    expect(shown.map(product => Number(product.price))).toEqual(expectedPrices);
  }
  const query = normalize(selected[0].name);
  await search.fill(query);
  const exactMatches = selected.filter(product => normalize(`${product.name} ${product.category_name || category.name}`).includes(query));
  await expect(page.locator('.product-card')).toHaveCount(Math.min(PAGE_SIZE, exactMatches.length));
  expect((await shownProducts(page, products)).every(product => exactMatches.some(expected => expected.product_id === product.product_id))).toBe(true);
  await search.fill('khong-co-san-pham-voi-tu-khoa-nay');
  await expect(page.getByRole('heading', { name: 'Chưa tìm thấy sản phẩm phù hợp', exact: true })).toBeVisible();
  await expect(page.locator('.catalog-summary')).toContainText('/ 0 sản phẩm');
  await expect(page.locator('.product-card')).toHaveCount(0);
  await page.locator('.empty-state').getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('.catalog-filter').getByRole('button', { name: 'Tất cả sản phẩm', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.product-card')).toHaveCount(Math.min(PAGE_SIZE, products.length));
});

test('dữ liệu thật, giá VNĐ và tải thêm không trùng; đổi bộ lọc đặt lại giới hạn', async ({ page, request }, testInfo) => {
  const { products, categories } = await getRealData(request);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/products');
  await waitForListing(page);
  await expect(page.locator('.catalog-filter button')).toHaveCount(categories.length + 1);
  const newest = [...products].sort((a, b) => Number(b.product_id) - Number(a.product_id))[0];
  await expect(page.locator('.product-card').first().locator('h3')).toHaveText(newest.name);
  await expect(page.locator('.product-card').first().locator('.product-price')).toHaveText(new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(newest.price)));
  let count = Math.min(PAGE_SIZE, products.length);
  while (count < products.length) {
    await page.getByRole('button', { name: 'Xem thêm sản phẩm', exact: true }).click();
    count = Math.min(count + PAGE_SIZE, products.length);
    await expect(page.locator('.product-card')).toHaveCount(count);
  }
  await expect(page.getByRole('button', { name: 'Xem thêm sản phẩm', exact: true })).toHaveCount(0);
  const shown = await shownProducts(page, products);
  expect(new Set(shown.map(product => product.product_id)).size).toBe(products.length);
  await expect(page.locator('.catalog-summary')).toContainText(`/ ${products.length} sản phẩm`);
  await page.getByRole('combobox', { name: 'Sắp xếp sản phẩm' }).selectOption('price-asc');
  await expect(page.locator('.product-card')).toHaveCount(Math.min(PAGE_SIZE, products.length));
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: testInfo.outputPath('products-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('hiển thị trạng thái đang tải độc lập cho sản phẩm và danh mục', async ({ page }) => {
  let releaseProducts;
  let releaseCategories;
  const productsReady = new Promise(resolve => { releaseProducts = resolve; });
  const categoriesReady = new Promise(resolve => { releaseCategories = resolve; });
  await page.route(PRODUCTS, async route => { await productsReady; await route.continue(); });
  await page.route(CATEGORIES, async route => { await categoriesReady; await route.continue(); });
  try {
    await page.goto('/products', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status', { name: 'Đang tải sản phẩm' })).toBeVisible();
    await expect(page.locator('.listing-category-status')).toContainText('Đang tải danh mục');
    releaseProducts();
    await expect(page.locator('.product-card').first()).toBeVisible();
    await expect(page.locator('.listing-category-status')).toContainText('Đang tải danh mục');
    releaseCategories();
    await expect(page.getByRole('status', { name: 'Đang tải sản phẩm' })).toHaveCount(0);
    await expect(page.locator('.catalog-filter button').nth(1)).toBeVisible();
  } finally {
    releaseProducts();
    releaseCategories();
  }
});

test('lỗi từng API có thử lại riêng và không chặn dữ liệu API còn lại', async ({ page, request }) => {
  const { categories } = await getRealData(request);
  await page.route(PRODUCTS, route => route.fulfill({ status: 503, json: { success: false } }));
  await page.route(CATEGORIES, route => route.fulfill({ status: 503, json: { success: false } }));
  await page.goto('/products');
  const productError = page.locator('.error-notice').filter({ has: page.getByRole('heading', { name: 'Chưa tải được sản phẩm', exact: true }) });
  const categoryError = page.locator('.error-notice').filter({ has: page.getByRole('heading', { name: 'Chưa tải được danh mục', exact: true }) });
  await expect(productError).toBeVisible();
  await expect(categoryError).toBeVisible();
  await page.unroute(PRODUCTS);
  await productError.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.locator('.product-card').first()).toBeVisible();
  await expect(categoryError).toBeVisible();
  await page.unroute(CATEGORIES);
  await categoryError.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.locator('.catalog-filter button')).toHaveCount(categories.length + 1);
  await expect(page.locator('.error-notice')).toHaveCount(0);
});

test('API rỗng không tạo sản phẩm mẫu và vẫn báo số kết quả bằng 0', async ({ page }) => {
  await page.route(PRODUCTS, route => route.fulfill({ json: { success: true, total: 0, products: [] } }));
  await page.goto('/products');
  await expect(page.getByRole('heading', { name: 'Sản phẩm đang được cập nhật', exact: true })).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
  await expect(page.locator('.catalog-summary')).toContainText('/ 0 sản phẩm');
});

test('thẻ dùng chung thêm giỏ khách, khóa hết hàng và không tràn ở mobile', async ({ page, request }, testInfo) => {
  const { products } = await getRealData(request);
  const newest = [...products].sort((a, b) => Number(b.product_id) - Number(a.product_id))[0];
  const fixture = products.map(product => ({ ...product, stock_quantity: product.product_id === newest.product_id ? 0 : 3 }));
  await page.route(PRODUCTS, route => route.fulfill({ json: { success: true, total: fixture.length, products: fixture } }));
  const writes = [];
  page.on('request', req => { if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && new URL(req.url()).pathname !== '/api/cart/preview') writes.push(req.url()); });
  await page.goto('/products');
  await waitForListing(page);
  const unavailable = page.locator(`[data-product-id="${newest.product_id}"]`);
  await expect(unavailable.locator('.buy-now')).toBeDisabled();
  await expect(unavailable.locator('.add-to-cart')).toBeDisabled();
  await expect(unavailable.locator('.stock-badge')).toContainText('hết hàng');
  const available = page.locator('.product-card').filter({ has: page.locator('.buy-now:not(:disabled)') }).first();
  const url = page.url();
  await available.locator('.add-to-cart').click();
  await expect(page.locator('.feature-notice')).toContainText(/Đã thêm|thêm.*thành công/i);
  expect(page.url()).toBe(url);
  await page.locator('.feature-notice button').click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const layout = await page.evaluate(() => ({
      noOverflow: document.documentElement.scrollWidth <= innerWidth,
      actionsFit: [...document.querySelectorAll('.product-actions')].every(group => {
        const [buy, cart] = group.children;
        const b = buy.getBoundingClientRect();
        const c = cart.getBoundingClientRect();
        return Math.abs(b.height - c.height) < 1 && b.right <= c.left && c.right <= innerWidth && buy.scrollWidth <= buy.clientWidth;
      }),
    }));
    expect(layout, `Bố cục ở ${width}px`).toEqual({ noOverflow: true, actionsFit: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('products-mobile.png'), fullPage: true });
  expect(writes).toEqual([]);
});
