import { test, expect } from '@playwright/test';
import { expectOnlyMockedApis, mockChatbot } from './helpers/chatbot-mock.js';

let mock;
test.beforeEach(async ({ page, baseURL }) => {
  mock = await mockChatbot(page, { frontendOrigin: baseURL });
});
test.afterEach(() => { expectOnlyMockedApis(mock); });

test('ảnh trang chủ tải thật, tìm kiếm header và bố cục không tràn ngang', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.category-tile')).toHaveCount(5);
  await expect(page.locator('.product-card')).toHaveCount(8);
  await page.evaluate(() => document.fonts.ready);
  const artwork = page.locator('.hero-photo, .category-art img');
  await expect(artwork).toHaveCount(6);
  await expect.poll(() => artwork.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  const banner = await page.locator('.care-banner').evaluate(async element => {
    const source = getComputedStyle(element).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (!source) return false;
    const image = new Image();
    image.src = source;
    await image.decode();
    return image.naturalWidth > 0;
  });
  expect(banner).toBe(true);
  const name = await page.locator('.product-card h3').first().textContent();
  const search = page.getByRole('searchbox', { name: 'Tìm kiếm sản phẩm' });
  await search.fill(name);
  await search.press('Enter');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.product-card h3')).toHaveText(name);
  await page.getByRole('button', { name: 'Xóa tìm kiếm' }).click();
  await expect(page.locator('.product-card')).toHaveCount(8);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('homepage-1440.png'), fullPage: true });
});

test('chatbot gọi API mock, giữ hội thoại khi đóng mở và quản lý focus', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Mở AI Chatbot', exact: true });
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'AI Chatbot PetCareShop' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'false');
  const input = dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' });
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true })).toBeDisabled();
  await input.fill('Tôi muốn tư vấn thức ăn cho mèo.');
  await input.press('Enter');
  const conversation = dialog.getByRole('log', { name: 'Hội thoại chatbot' });
  await expect(conversation.locator('.chatbot-user')).toHaveCount(1);
  await expect(conversation.locator('.chatbot-assistant')).toHaveCount(1);
  await expect(conversation).toContainText('Tôi muốn tư vấn thức ăn cho mèo.');
  await expect(conversation).toContainText('Bạn có thể tham khảo lựa chọn');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(mock.calls).toHaveLength(1);
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.getByRole('log')).toContainText('Tôi muốn tư vấn thức ăn cho mèo.');
  await dialog.getByRole('button', { name: 'Đóng chatbot', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('liên hệ dùng tel/mailto thật và không tự tạo địa chỉ Messenger/Zalo', async ({ page }) => {
  await page.goto('/');
  const contacts = page.getByRole('complementary', { name: 'Kênh liên hệ PetCareShop' });
  await expect(contacts.getByRole('button', { name: 'Messenger — chưa cấu hình kênh liên hệ' })).toHaveAttribute('aria-disabled', 'true');
  await expect(contacts.getByRole('button', { name: 'Zalo — chưa cấu hình kênh liên hệ' })).toHaveAttribute('aria-disabled', 'true');
  await expect(contacts.getByRole('link', { name: 'Hotline: 0987 654 321' })).toHaveAttribute('href', 'tel:0987654321');
  await expect(contacts.getByRole('link', { name: 'Email: petcare@gmail.com' })).toHaveAttribute('href', 'mailto:petcare@gmail.com');
});

test('chatbot nằm trong màn hình ở desktop, tablet và mobile', async ({ page }, testInfo) => {
  await page.goto('/');
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Mở AI Chatbot', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Chatbot PetCareShop' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' });
    if (viewport.width === 1440) {
      await expect(input).toBeEnabled();
      await input.fill('Tôi muốn tìm sản phẩm cho mèo.');
      await input.press('Enter');
      await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
    }
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`chatbot-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: 'Đóng chatbot' }).click();
  }
});
