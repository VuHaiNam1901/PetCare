import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const PRODUCTS = `${ORIGIN}/api/products`;
const CATEGORIES = `${ORIGIN}/api/categories`;
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

async function getRealData(request) {
  const [productsResponse, categoriesResponse] = await Promise.all([request.get(PRODUCTS), request.get(CATEGORIES)]);
  expect(productsResponse.ok(), 'Backend thật phải chạy ở cổng 3000').toBeTruthy();
  expect(categoriesResponse.ok()).toBeTruthy();
  const [productBody, categoryBody] = await Promise.all([productsResponse.json(), categoriesResponse.json()]);
  expect(productBody.success).toBe(true);
  expect(categoryBody.success).toBe(true);
  return { products: productBody.products, categories: categoryBody.categories };
}

async function prepareScreenshot(page) {
  await page.locator('.product-card').last().scrollIntoViewIfNeeded();
  await page.locator('#hero-title').scrollIntoViewIfNeeded();
  await page.locator('.product-image img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function waitForProducts(page) {
  await expect(page.locator('.product-card').first()).toBeVisible();
}

test('hiển thị dữ liệu API thật, giá VNĐ, danh mục và không có lỗi JavaScript', async ({ page, request }, testInfo) => {
  const { products, categories } = await getRealData(request);
  expect(products.length).toBeGreaterThan(0);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForProducts(page);
  await expect(page).toHaveTitle(/PetCare/);
  await expect(page.locator('.category-tile')).toHaveCount(categories.length);
  await expect(page.locator('.product-card')).toHaveCount(Math.min(8, products.length));
  const newest = [...products].sort((a, b) => Number(b.product_id) - Number(a.product_id))[0];
  const firstCard = page.locator('.product-card').first();
  await expect(firstCard.locator('h3')).toHaveText(newest.name);
  await expect(firstCard.locator('.product-category')).toHaveText(newest.category_name);
  await expect(firstCard.locator('.product-price')).toHaveText(new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(newest.price)));
  await expect(page.locator('#hero-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await prepareScreenshot(page);
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('lọc theo danh mục thật và tìm kiếm không dấu, xóa bộ lọc', async ({ page, request }) => {
  const { products, categories } = await getRealData(request);
  const category = categories.find(item => products.some(product => String(product.category_id) === String(item.category_id)));
  await page.goto('/');
  await waitForProducts(page);
  const tile = page.locator('.category-tile').filter({ has: page.locator('.category-name', { hasText: category.name }) });
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  const expected = products.filter(product => String(product.category_id) === String(category.category_id));
  await expect(page.locator('.product-card')).toHaveCount(Math.min(8, expected.length));
  const shownNames = await page.locator('.product-card h3').allTextContents();
  expect(shownNames.every(name => expected.some(product => product.name === name))).toBe(true);
  await page.getByRole('button', { name: 'Tất cả sản phẩm', exact: true }).click();
  const query = normalize(products[0].name);
  await page.getByRole('searchbox', { name: 'Tìm kiếm sản phẩm' }).fill(query);
  await expect(page.locator('.product-card').first().locator('h3')).toHaveText(products[0].name);
  await page.getByRole('searchbox').fill('khong-co-san-pham-voi-tu-khoa-nay');
  await expect(page.getByRole('heading', { name: 'Chưa tìm thấy sản phẩm phù hợp' })).toBeVisible();
  await page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(Math.min(8, products.length));
});

test('sắp xếp giá và tải thêm đầy đủ sản phẩm thật', async ({ page, request }) => {
  const { products } = await getRealData(request);
  await page.goto('/');
  await waitForProducts(page);
  await page.getByRole('combobox', { name: 'Sắp xếp sản phẩm' }).selectOption('price-asc');
  let count = Math.min(8, products.length);
  while (count < products.length) {
    await page.getByRole('button', { name: 'Xem thêm sản phẩm', exact: true }).click();
    count = Math.min(count + 8, products.length);
    await expect(page.locator('.product-card')).toHaveCount(count);
  }
  const ids = await page.locator('.product-card').evaluateAll(cards => cards.map(card => card.dataset.productId));
  expect(new Set(ids).size).toBe(products.length);
  const prices = ids.map(id => Number(products.find(product => String(product.product_id) === id).price));
  expect(prices).toEqual([...prices].sort((a, b) => a - b));
  await page.getByRole('combobox').selectOption('price-desc');
  await expect(page.locator('.product-card')).toHaveCount(Math.min(8, products.length));
  const highest = Math.max(...products.map(product => Number(product.price)));
  const firstId = await page.locator('.product-card').first().getAttribute('data-product-id');
  expect(Number(products.find(product => String(product.product_id) === firstId).price)).toBe(highest);
});

test('hiện skeleton khi API tải chậm', async ({ page }) => {
  await page.route(PRODUCTS, async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status', { name: 'Đang tải sản phẩm' })).toBeVisible();
  await waitForProducts(page);
  await expect(page.getByRole('status', { name: 'Đang tải sản phẩm' })).toHaveCount(0);
});

test('lỗi sản phẩm có thông báo, danh mục vẫn hoạt động và thử lại lấy dữ liệu thật', async ({ page }) => {
  await page.route(PRODUCTS, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chưa tải được sản phẩm', exact: true })).toBeVisible();
  await expect(page.locator('.category-tile').first()).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
  await page.unroute(PRODUCTS);
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await waitForProducts(page);
});

test('lỗi danh mục không che sản phẩm và có thể thử lại', async ({ page, request }) => {
  const { categories } = await getRealData(request);
  await page.route(CATEGORIES, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: false }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chưa tải được danh mục', exact: true })).toBeVisible();
  await waitForProducts(page);
  await page.unroute(CATEGORIES);
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.locator('.category-tile')).toHaveCount(categories.length);
});

test('danh sách rỗng hiển thị trạng thái rõ ràng, không sinh sản phẩm mẫu', async ({ page }) => {
  await page.route(PRODUCTS, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, total: 0, products: [] }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sản phẩm đang được cập nhật' })).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
});

test('ảnh sản phẩm tải lỗi được thay bằng placeholder trung tính', async ({ page }) => {
  await page.route('**/*', route => {
    if (route.request().resourceType() === 'image' && !route.request().url().includes('/images/hero-dog.jpg') && !route.request().url().includes('/favicon.svg')) return route.abort();
    return route.continue();
  });
  await page.goto('/');
  await waitForProducts(page);
  await page.locator('.product-card').first().scrollIntoViewIfNeeded();
  await expect(page.locator('.product-image-fallback').first()).toBeVisible();
  await expect(page.locator('.product-image-fallback').first()).toContainText('Ảnh đang cập nhật');
});

test('responsive ở 390px và 768px, menu điện thoại hoạt động', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForProducts(page);
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' }).getByRole('link', { name: 'Sản phẩm', exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Danh sách sản phẩm' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mở menu', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Điều hướng trên điện thoại' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.product-card').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('ảnh CDN kích thước lớn lỗi sẽ quay về URL ảnh gốc từ API', async ({ page, request }) => {
  const { products } = await getRealData(request);
  const newest = [...products].sort((a, b) => Number(b.product_id) - Number(a.product_id))[0];
  const originalUrl = 'https://cdn.hstatic.net/products/test-legacy-fallback_compact.jpg';
  const largeUrl = 'https://cdn.hstatic.net/products/test-legacy-fallback_large.jpg';
  const imageResponse = await request.get('/images/hero-dog.jpg');
  expect(imageResponse.ok()).toBe(true);
  const imageBytes = await imageResponse.body();
  // A controlled legacy fixture keeps this regression meaningful after all real
  // products use local files. This is separate from the real migration checks.
  const fixture = products.map(product => product.product_id === newest.product_id ? { ...product, image_url: originalUrl } : product);
  await page.route(PRODUCTS, route => route.fulfill({ json: { success: true, total: fixture.length, products: fixture } }));
  const attempts = [];
  await page.route('https://cdn.hstatic.net/products/test-legacy-fallback_*', route => {
    const url = route.request().url();
    attempts.push(url);
    if (url === largeUrl) return route.abort();
    if (url === originalUrl) return route.fulfill({ contentType: 'image/jpeg', body: imageBytes });
    return route.abort();
  });
  await page.goto('/');
  await waitForProducts(page);
  const card = page.locator(`[data-product-id="${newest.product_id}"]`);
  await card.scrollIntoViewIfNeeded();
  const originalImage = card.locator('.product-image img');
  await expect(originalImage).toHaveAttribute('src', originalUrl);
  await expect.poll(() => originalImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(card.locator('.product-image-fallback')).toHaveCount(0);
  expect(attempts).toEqual([largeUrl, originalUrl]);
});
