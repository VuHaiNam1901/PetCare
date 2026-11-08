import { test, expect } from '@playwright/test';

const API = 'http://localhost:3000';
const viewports = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
];

test.beforeEach(async ({ page }) => {
  await page.route(`${API}/api/**`, async route => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || new URL(request.url()).pathname === '/api/cart/preview') return route.continue();
    await route.abort();
    throw new Error(`Unexpected API mutation during layout verification: ${request.method()} ${request.url()}`);
  });
});

async function catalog(request) {
  const response = await request.get(`${API}/api/products`);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.products.length).toBeGreaterThan(0);
  return body.products;
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = element => {
      const { x, y, width, height, top, right, bottom, left } = element.getBoundingClientRect();
      return { x, y, width, height, top, right, bottom, left };
    };
    const element = selector => document.querySelector(selector);
    const measure = selector => rect(element(selector));
    const style = selector => getComputedStyle(element(selector));
    const image = element('.detail-image img');
    const layoutStyle = style('.detail-layout');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth },
      container: measure('.product-detail-page'),
      header: measure('.site-header'),
      layout: measure('.detail-layout'),
      frame: measure('.detail-image'),
      image: image ? rect(image) : null,
      naturalWidth: image?.naturalWidth,
      naturalHeight: image?.naturalHeight,
      imageFit: image ? getComputedStyle(image).objectFit : '',
      imagePosition: image ? getComputedStyle(image).objectPosition : '',
      imageTransform: image ? getComputedStyle(image).transform : '',
      imageScale: image ? getComputedStyle(image).scale : '',
      frameOverflow: style('.detail-image').overflow,
      info: measure('.detail-info'),
      infoMinWidth: style('.detail-info').minWidth,
      title: measure('#detail-title'),
      titleFont: parseFloat(style('#detail-title').fontSize),
      price: measure('.detail-price'),
      priceFont: parseFloat(style('.detail-price').fontSize),
      quantity: measure('.detail-quantity'),
      bodyFonts: ['.detail-category', '.detail-stock', '.detail-quantity', '.detail-description'].map(selector => ({ selector, size: parseFloat(style(selector).fontSize) })),
      gap: parseFloat(layoutStyle.columnGap),
      actions: measure('.detail-actions'),
      buttons: [...document.querySelectorAll('.detail-actions .button')].map(button => ({ ...rect(button), text: button.textContent.trim() })),
    };
  });
}

function expectInside(child, parent) {
  expect(child.left).toBeGreaterThanOrEqual(parent.left - .5);
  expect(child.right).toBeLessThanOrEqual(parent.right + .5);
  expect(child.top).toBeGreaterThanOrEqual(parent.top - .5);
  expect(child.bottom).toBeLessThanOrEqual(parent.bottom + .5);
}

function expectImageContained(box) {
  expect(box.naturalWidth).toBeGreaterThan(0);
  expect(box.naturalHeight).toBeGreaterThan(0);
  expectInside(box.image, box.frame);
  expect(box.imageFit).toBe('contain');
  expect(box.imagePosition).toBe('50% 50%');
  expect(box.imageTransform).toBe('none');
  expect(box.imageScale).toBe('none');
  expect(box.frameOverflow).toBe('visible');
  expect(Math.abs((box.image.left + box.image.right) / 2 - (box.frame.left + box.frame.right) / 2)).toBeLessThan(1);
  expect(Math.abs((box.image.top + box.image.bottom) / 2 - (box.frame.top + box.frame.bottom) / 2)).toBeLessThan(1);
}

for (const viewport of viewports) {
  test(`real product detail layout stays compact and contains every image at ${viewport.width}x${viewport.height}`, async ({ page, request }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize(viewport);
    const products = await catalog(request);
    const longest = [...products].sort((a, b) => b.name.length - a.name.length)[0];
    const measurements = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const product of products) {
      await page.goto(`/products/${product.product_id}`);
      await expect(page.locator('#detail-title')).toHaveText(product.name);
      await page.locator('.detail-image img').evaluate(image => image.decode());
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.detail-image').hover();
      await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      const box = await geometry(page);
      expect(box.scroll.width, product.name).toBeLessThanOrEqual(viewport.width);
      expect(box.scroll.y).toBe(0);
      expect(box.container.width).toBeLessThanOrEqual(1200);
      expect(Math.abs(box.container.left - (viewport.width - box.container.width) / 2)).toBeLessThan(1);
      expect(box.layout.left).toBeGreaterThanOrEqual(16);
      expect(box.layout.right).toBeLessThanOrEqual(viewport.width - 16);
      expect(box.infoMinWidth).toBe('0px');
      expectImageContained(box);
      expectInside(box.frame, box.layout);
      expectInside(box.info, box.layout);
      expect(box.buttons).toHaveLength(2);
      for (const button of box.buttons) {
        expect(button.height).toBeGreaterThanOrEqual(46);
        expect(button.height).toBeLessThanOrEqual(48);
        expectInside(button, box.actions);
      }
      if (viewport.width > 850) {
        expect(box.frame.height).toBeGreaterThanOrEqual(380);
        expect(box.frame.height).toBeLessThanOrEqual(420);
        expect(box.frame.width / (box.frame.width + box.info.width)).toBeCloseTo(.42, 2);
        expect(box.info.left - box.frame.right).toBeCloseTo(32, 0);
        expect(box.titleFont).toBeGreaterThanOrEqual(26);
        expect(box.titleFont).toBeLessThanOrEqual(28);
        expect(box.priceFont).toBeGreaterThanOrEqual(28);
        expect(box.priceFont).toBeLessThanOrEqual(30);
        for (const font of box.bodyFonts) {
          expect(font.size, font.selector).toBeGreaterThanOrEqual(15);
          expect(font.size, font.selector).toBeLessThanOrEqual(16);
        }
        for (const control of [box.title, box.price, box.quantity, ...box.buttons]) {
          expect(control.top).toBeGreaterThanOrEqual(box.header.bottom);
          expect(control.bottom, `${product.name}: main purchase controls fit the initial viewport`).toBeLessThanOrEqual(viewport.height - 12);
        }
      } else {
        expect(box.frame.height).toBeGreaterThanOrEqual(260);
        expect(box.frame.height).toBeLessThanOrEqual(300);
        expect(box.info.top).toBeGreaterThanOrEqual(box.frame.bottom);
        expect(Math.abs((box.frame.left + box.frame.right) / 2 - viewport.width / 2)).toBeLessThan(1);
      }
      measurements.push({ product_id: product.product_id, name: product.name, ...box });
      if (product.product_id === longest.product_id || product.product_id === 18) {
        await page.screenshot({ path: testInfo.outputPath(`product-${product.product_id}.png`) });
      }
    }
    expect(errors).toEqual([]);
    await testInfo.attach('product-detail-layout.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  });
}

for (const viewport of [viewports[0], viewports[2]]) {
  test(`detail missing-image fallback keeps the bounded frame at ${viewport.width}px`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const product = (await catalog(request))[0];
    await page.route(`${API}/api/products`, route => route.fulfill({ json: { success: true, total: 1, products: [{ ...product, image_url: null }] } }));
    await page.goto(`/products/${product.product_id}`);
    await expect(page.locator('#detail-title')).toHaveText(product.name);
    const fallback = page.locator('.detail-image .product-image-fallback');
    await expect(fallback).toBeVisible();
    const boxes = await fallback.evaluate(element => {
      const rect = node => {
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      return { fallback: rect(element), frame: rect(element.parentElement) };
    });
    expectInside(boxes.fallback, boxes.frame);
    expect(boxes.frame.height).toBeGreaterThanOrEqual(viewport.width > 850 ? 380 : 260);
    expect(boxes.frame.height).toBeLessThanOrEqual(viewport.width > 850 ? 420 : 300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
