import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PRODUCTS = 'http://localhost:3000/api/products';
const migrationFile = name => new URL(`../../image-migration/archive/final-20261017/${name}`, import.meta.url);
const readManifest = () => JSON.parse(fs.readFileSync(migrationFile('manifest.json'), 'utf8'));

function observeBackendImages(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.port === '3000' && url.pathname.startsWith('/images/products/')) requests.push(request.url());
  });
  return requests;
}

async function loadAllCards(page) {
  await page.goto('/');
  await expect(page.locator('.product-card')).toHaveCount(8);
  const more = page.getByRole('button', { name: 'Xem thêm sản phẩm', exact: true });
  while (await more.count()) await more.click();
  await expect(page.locator('.product-card')).toHaveCount(21);
}

async function checkImages(page, request, manifest) {
  const images = [];
  for (const item of manifest) {
    const card = page.locator(`[data-product-id="${item.product_id}"]`);
    await card.scrollIntoViewIfNeeded();
    const image = card.locator('img');
    await expect(image).toHaveAttribute('src', item.local_path);
    await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(card.locator('.product-image-fallback')).toHaveCount(0);
    const measured = await image.evaluate(img => ({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, currentSrc: img.currentSrc }));
    expect(measured.naturalWidth).toBe(item.width);
    expect(measured.naturalHeight).toBe(item.height);
    expect(measured.currentSrc).toBe(new URL(item.local_path, page.url()).href);
    const response = await request.get(item.local_path);
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(item.sha256);
    images.push({ product_id: item.product_id, local_path: item.local_path, sha256, ...measured });
  }
  await expect(page.locator('.product-image-fallback')).toHaveCount(0);
  return images;
}

test('all 21 current API images match the final mapping and valid WebP files', async ({ request }, testInfo) => {
  const manifest = readManifest();
  expect(manifest).toHaveLength(21);
  expect(new Set(manifest.map(item => item.product_id)).size).toBe(21);
  expect(new Set(manifest.map(item => item.local_path)).size).toBe(21);
  expect(manifest.every(item => item.content_approved === true && item.content_approval_source === 'user')).toBe(true);
  const response = await request.get(PRODUCTS);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.products).toHaveLength(21);
  const files = [];
  for (const item of manifest) {
    const product = body.products.find(p => p.product_id === item.product_id);
    expect(product).toBeDefined();
    expect(product.name).toBe(item.name);
    expect(product.description).toBe(item.description);
    expect(product.image_url).toBe(item.local_path);
    expect(item.local_path).toMatch(new RegExp(`^/images/products/${item.product_id}-[a-z0-9-]+\\.webp$`));
    const localFile = new URL(`../public${item.local_path}`, import.meta.url);
    const bytes = fs.readFileSync(localFile);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(item.sha256);
    const imageResponse = await request.get(item.local_path);
    expect(imageResponse.ok()).toBe(true);
    expect(imageResponse.headers()['content-type']).toContain('image/webp');
    expect(await imageResponse.body()).toEqual(bytes);
    files.push({ product_id: item.product_id, local_path: item.local_path, sha256, bytes: bytes.length });
  }
  await testInfo.attach('current-image-files.json', { body: JSON.stringify({ checkedAt: new Date().toISOString(), apiMocked: false, files }, null, 2), contentType: 'application/json' });
});

test('image helpers safely handle local, legacy, empty and invalid values', async ({ page }) => {
  await page.goto('/');
  const actual = await page.evaluate(async () => {
    const { resolveImageUrl: resolve, displayImageUrl: display } = await import('/src/utils/catalog.js');
    return {
      local: resolve('/images/products/me-o-tuna-1-2kg.webp'),
      localDisplay: display('/images/products/me-o-tuna-1-2kg.webp'),
      external: display('https://example.com/photo.webp'),
      legacy: resolve('/uploads/photo.jpg'),
      cdn: display('https://cdn.hstatic.net/products/a_small.jpg'),
      invalid: [undefined, null, '', ' ', {}, 123, 'http://[', 'javascript:alert(1)', 'data:image/png,abc'].map(display),
      traversal: resolve('/images/products/../../secret.webp'),
    };
  });
  expect(actual).toEqual({
    local: '/images/products/me-o-tuna-1-2kg.webp', localDisplay: '/images/products/me-o-tuna-1-2kg.webp',
    external: 'https://example.com/photo.webp', legacy: 'http://localhost:3000/uploads/photo.jpg',
    cdn: 'https://cdn.hstatic.net/products/a_large.jpg', invalid: Array(9).fill(''), traversal: '',
  });
});

test('local image uses frontend; failed image stops retrying and recovers on source change', async ({ page, request }) => {
  const photo = await request.get('/images/hero-dog.jpg');
  expect(photo.ok()).toBe(true);
  const body = await photo.body();
  const imageRequests = [];
  page.on('request', req => { if (req.url().includes('/images/products/')) imageRequests.push(req.url()); });
  await page.route('**/images/products/test-missing.webp', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/images/products/test-working.webp', route => route.fulfill({ contentType: 'image/jpeg', body }));
  await page.goto('/');
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const domModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = domModule.default || domModule;
    const { default: ProductCard } = await import('/src/components/ProductCard.jsx');
    const host = document.createElement('div');
    host.id = 'image-test';
    document.body.prepend(host);
    const root = createRoot(host);
    window.renderImageTest = image_url => root.render(React.createElement(ProductCard, { product: { product_id: 'test', name: 'Image test', image_url } }));
    window.renderImageTest('/images/products/test-missing.webp');
  });
  await expect(page.locator('#image-test .product-image-fallback')).toBeVisible();
  await page.evaluate(() => window.renderImageTest('/images/products/test-working.webp'));
  await expect.poll(() => page.locator('#image-test img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('#image-test .product-image-fallback')).toHaveCount(0);
  expect(imageRequests.filter(url => url.includes('test-missing'))).toHaveLength(1);
  expect(imageRequests.every(url => new URL(url).port === '5173')).toBe(true);
});

test('all 21 real product images load without fallback or backend image requests', async ({ page, request }, testInfo) => {
  const manifest = readManifest();
  expect(manifest).toHaveLength(21);
  const response = await request.get(PRODUCTS);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.success).toBe(true);
  const { products } = body;
  expect(products).toHaveLength(21);
  for (const item of manifest) {
    const product = products.find(p => p.product_id === item.product_id);
    expect(product).toBeDefined();
    expect(product.image_url).toBe(item.local_path);
    expect(product.name).toBe(item.name);
    expect(product.description).toBe(item.description);
    expect(item.content_approved).toBe(true);
  }
  const backendRequests = observeBackendImages(page);
  const browserApi = page.waitForResponse(response => response.url() === PRODUCTS && response.request().method() === 'GET');
  await loadAllCards(page);
  const browserBody = await (await browserApi).json();
  expect(browserBody.products).toEqual(products);
  const images = await checkImages(page, request, manifest);
  for (const item of manifest) await expect(page.locator(`[data-product-id="${item.product_id}"] h3`)).toHaveText(item.name);
  expect(backendRequests).toEqual([]);
  await testInfo.attach('current-image-browser.json', { body: JSON.stringify({ batch_id: manifest[0].batch_id, review_revision: manifest[0].review_revision, checkedAt: new Date().toISOString(), mode: 'real-api', apiMocked: false, api_products: browserBody.products, images, fallbackCount: 0, backendRequests }, null, 2), contentType: 'application/json' });
});
