import { test, expect } from '@playwright/test';

const API = 'http://localhost:3000';
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 900 },
  { width: 760, height: 900 },
  { width: 620, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
];

async function loadFullGuestCart(page, request) {
  const response = await request.get(`${API}/api/products`);
  expect(response.ok()).toBe(true);
  const { products } = await response.json();
  expect(products.length).toBeGreaterThan(0);
  // Only the isolated browser's guest cart is seeded; preview reads the real catalog.
  await page.addInitScript(items => {
    localStorage.setItem('petcare.guest-cart.v1', JSON.stringify({ version: 1, items }));
  }, products.map(product => ({ product_id: product.product_id, quantity: 1, selected: true })));
  await page.goto('/cart');
  await expect(page.locator('.cart-row')).toHaveCount(products.length);
  return products;
}

async function measureImage(frame, childSelector) {
  return frame.evaluate((element, selector) => {
    const child = element.querySelector(selector);
    const row = element.closest('.cart-row');
    const rect = node => {
      const { x, y, width, height, top, right, bottom, left } = node.getBoundingClientRect();
      return { x, y, width, height, top, right, bottom, left };
    };
    const style = getComputedStyle(child);
    const rowStyle = getComputedStyle(row);
    return {
      frame: rect(element), child: rect(child), row: rect(row),
      display: style.display, fit: style.objectFit, position: style.objectPosition,
      transform: style.transform, scale: style.scale,
      overflow: getComputedStyle(element).overflow,
      paddingTop: parseFloat(rowStyle.paddingTop), paddingBottom: parseFloat(rowStyle.paddingBottom),
      product: rect(row.querySelector('.cart-row-product')),
    };
  }, childSelector);
}

function expectContained(box, size) {
  expect(box.frame.width).toBe(size);
  expect(box.frame.height).toBe(size);
  expect(box.child.left).toBeGreaterThanOrEqual(box.frame.left);
  expect(box.child.right).toBeLessThanOrEqual(box.frame.right);
  expect(box.child.top).toBeGreaterThanOrEqual(box.frame.top);
  expect(box.child.bottom).toBeLessThanOrEqual(box.frame.bottom);
  expect(box.frame.top - box.row.top).toBeGreaterThanOrEqual(box.paddingTop - 1);
  expect(box.row.bottom - box.frame.bottom).toBeGreaterThanOrEqual(box.paddingBottom - 1);
  expect(box.frame.right).toBeLessThanOrEqual(box.product.left);
  // A passing layout must constrain the image without clipping it.
  expect(box.overflow).toBe('visible');
}

for (const viewport of viewports) {
  test(`all cart images stay inside their rows at ${viewport.width}px, including after scrolling`, async ({ page, request }, testInfo) => {
    await page.setViewportSize(viewport);
    const writes = [];
    page.on('request', req => {
      if (req.url().startsWith(API) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && new URL(req.url()).pathname !== '/api/cart/preview') writes.push(req.url());
    });
    const products = await loadFullGuestCart(page, request);
    const size = viewport.width <= 760 ? 64 : 80;
    const measurements = [];
    for (const product of [...products].sort((a, b) => a.product_id - b.product_id)) {
      const frame = page.locator(`.cart-row[data-product-id="${product.product_id}"] .cart-row-image`);
      const image = frame.locator('img');
      await frame.scrollIntoViewIfNeeded();
      await expect(image).toHaveCount(1);
      await image.evaluate(img => img.decode());
      await frame.hover();
      const box = await measureImage(frame, 'img');
      expectContained(box, size);
      expect(box.child.width).toBe(size - 8);
      expect(box.child.height).toBe(size - 8);
      expect(box.display).toBe('block');
      expect(box.fit).toBe('contain');
      expect(box.position).toBe('50% 50%');
      expect(box.transform).toBe('none');
      expect(box.scale).toBe('none');
      measurements.push({ product_id: product.product_id, name: product.name, ...box });
    }
    // Recheck the tall bottles at the end after every lazy image has loaded.
    const shed = products.find(product => /SHED-X.*473ml/i.test(product.name));
    expect(shed).toBeDefined();
    const bottle = page.locator(`.cart-row[data-product-id="${shed.product_id}"]`);
    await bottle.scrollIntoViewIfNeeded();
    expectContained(await measureImage(bottle.locator('.cart-row-image'), 'img'), size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.cart-row-image .product-image-fallback')).toHaveCount(0);
    expect(writes).toEqual([]);
    await testInfo.attach('cart-image-measurements.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
    if ([1440, 390].includes(viewport.width)) {
      await page.screenshot({ path: testInfo.outputPath('cart-bottom.png') });
    }
  });
}

for (const width of [1440, 390]) {
  test(`missing cart image fallback also fits at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/images/products/**', route => route.abort());
    await loadFullGuestCart(page, request);
    const frame = page.locator('.cart-row-image').first();
    await frame.scrollIntoViewIfNeeded();
    await expect(frame.locator('.product-image-fallback')).toBeVisible();
    expectContained(await measureImage(frame, '.product-image-fallback'), width <= 760 ? 64 : 80);
  });
}
