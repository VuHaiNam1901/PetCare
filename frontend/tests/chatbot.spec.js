import { test, expect } from '@playwright/test';
import { chatReply, expectOnlyMockedApis, loginChatUser, mockChatbot, openChat, products, sendChat, sessionFor, tokenFor } from './helpers/chatbot-mock.js';

test('gửi đúng contract, hiển thị lời tư vấn, cảnh báo và thẻ từ API mock', async ({ page, baseURL }, testInfo) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body }) => ({ body: chatReply(body, { warnings: ['Kiểm tra thông tin trên nhãn trước khi chọn.'] }) }) });
  await page.goto('/');
  const dialog = await openChat(page);
  await expect(dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true })).toBeDisabled();
  await sendChat(page, 'Tìm thức ăn cho mèo dưới 200k.');
  await expect(dialog.locator('.chatbot-user')).toHaveCount(1);
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  await expect(dialog).toContainText('Bạn có thể tham khảo lựa chọn');
  await expect(dialog).toContainText('Bạn muốn tìm trong khoảng ngân sách nào?');
  await expect(dialog).toContainText('Kiểm tra thông tin trên nhãn trước khi chọn.');
  await expect(dialog.locator('.chatbot-product-card a')).toHaveAttribute('href', '/products/1');
  await expect(dialog.locator('.chatbot-product-card a')).toContainText(products[0].name);
  await expect(dialog).toContainText('125.000');
  expect(state.calls).toHaveLength(1);
  expect(Object.keys(state.calls[0].body).sort()).toEqual(['message', 'request_id']);
  expect(state.calls[0].body.message).toBe('Tìm thức ăn cho mèo dưới 200k.');
  expect(state.calls[0].body.request_id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
  expect(state.calls[0].authorization).toBeUndefined();
  await expect(dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' })).toBeFocused();
  await dialog.screenshot({ path: testInfo.outputPath('chatbot-desktop.png') });
  expectOnlyMockedApis(state);
});

test('loading chặn gửi trùng; đóng mở trong lúc chờ giữ yêu cầu và session tiếp theo', async ({ page, baseURL }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: async ({ body, index }) => {
    if (index === 0) await gate;
    return { body: chatReply(body) };
  } });
  await page.goto('/');
  let dialog = await openChat(page);
  await sendChat(page, 'Mèo nên ăn gì?');
  await expect.poll(() => state.calls.length).toBe(1);
  await expect(dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true })).toBeDisabled();
  await dialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  expect(state.calls).toHaveLength(1);
  await expect(dialog).toContainText(/đang trả lời/i);
  await dialog.getByRole('button', { name: 'Đóng chatbot', exact: true }).click();
  await page.getByRole('button', { name: 'Mở AI Chatbot', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'AI Chatbot PetCareShop' });
  await expect(dialog).toContainText('Mèo nên ăn gì?');
  release();
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  await sendChat(page, 'Loại nào rẻ nhất?');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(2);
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1].body.session_id).toBe(sessionFor('guest'));
  expect(state.calls[1].body.request_id).not.toBe(state.calls[0].body.request_id);
  expectOnlyMockedApis(state);
});

for (const [status, code] of [[503, 'GEMINI_UNAVAILABLE'], [504, 'GEMINI_TIMEOUT']]) {
  test(`lỗi ${status}: giữ session và UUID khi thử lại, không thêm trùng tin người dùng`, async ({ page, baseURL }) => {
    const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body, index }) => index === 0
      ? { status, body: { success: false, code, message: 'Trợ lý đang tạm thời gián đoạn.', session_id: sessionFor('guest'), request_id: body.request_id } }
      : { body: chatReply(body, { replayed: true }) } });
    await page.goto('/');
    const dialog = await openChat(page);
    await sendChat(page, 'Tư vấn một lựa chọn cho mèo.');
    const retry = dialog.getByRole('button', { name: 'Thử lại', exact: true });
    await expect(retry).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(dialog.locator('.chatbot-assistant')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true })).toBeDisabled();
    await retry.click();
    await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
    await expect(dialog.locator('.chatbot-user')).toHaveCount(1);
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1].body).toEqual({ ...state.calls[0].body, session_id: sessionFor('guest') });
    expectOnlyMockedApis(state);
  });
}

test('429 tôn trọng Retry-After rồi thử lại nguyên yêu cầu', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body, index }) => index === 0
    ? { status: 429, headers: { 'retry-after': '2' }, body: { success: false, code: 'RATE_LIMITED', message: 'Bạn đã gửi quá nhiều tin nhắn.' } }
    : { body: chatReply(body) } });
  await page.goto('/');
  const dialog = await openChat(page);
  await sendChat(page, 'Tôi muốn tìm bát ăn.');
  const retry = dialog.getByRole('button', { name: 'Thử lại', exact: true });
  await expect(retry).toBeDisabled();
  expect(state.calls).toHaveLength(1);
  await expect(retry).toBeEnabled({ timeout: 5000 });
  await retry.click();
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[1].body).toEqual(state.calls[0].body);
  expectOnlyMockedApis(state);
});

test('mất mạng giữ tin đã gửi để thử lại, không giả tạo phản hồi', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body, index }) => index === 0 ? { abort: true } : { body: chatReply(body) } });
  await page.goto('/');
  const dialog = await openChat(page);
  await sendChat(page, 'Tôi cần đồ chơi cho mèo.');
  await expect(dialog.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(0);
  await expect(dialog).toContainText('Tôi cần đồ chơi cho mèo.');
  await dialog.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[1].body).toEqual(state.calls[0].body);
  expectOnlyMockedApis(state);
});

test('nội dung và tên sản phẩm là text an toàn; không dùng URL ảnh thực thi mã', async ({ page, baseURL }) => {
  const text = '<img src=x onerror="window.__chatXss=1">';
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body }) => ({ body: chatReply(body, {
    message: text, follow_up: '<script>window.__chatXss=2</script>', warnings: ['<b>Không render HTML</b>'],
    products: [{ ...products[0], name: '<svg onload="window.__chatXss=3">', image_url: 'javascript:window.__chatXss=4' }],
  }) }) });
  await page.goto('/');
  const dialog = await openChat(page);
  await sendChat(page, text);
  await expect(dialog.locator('.chatbot-assistant')).toContainText(text);
  await expect(dialog.locator('.chatbot-user')).toContainText(text);
  await expect(dialog).toContainText('<script>window.__chatXss=2</script>');
  await expect(dialog).toContainText('<b>Không render HTML</b>');
  await expect(dialog.locator('.chatbot-product-card a')).toHaveAttribute('href', '/products/1');
  await expect(dialog.locator('.chatbot-product-card a')).toContainText('<svg onload="window.__chatXss=3">');
  expect(await page.evaluate(() => window.__chatXss)).toBeUndefined();
  await expect(dialog.locator('script, [onerror], [onload], img[src^="javascript:"]')).toHaveCount(0);
  expectOnlyMockedApis(state);
});

test('cuộc trò chuyện mới và tải lại không tái sử dụng session hoặc lịch sử cũ', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL });
  await page.goto('/');
  let dialog = await openChat(page);
  await sendChat(page, 'Tin riêng trong cuộc trò chuyện cũ.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Cuộc trò chuyện mới', exact: true }).click();
  await expect(dialog.locator('.chatbot-user')).toHaveCount(0);
  await sendChat(page, 'Tin trong cuộc trò chuyện mới.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[1].body.session_id).toBeUndefined();
  expect(state.calls[1].body.request_id).not.toBe(state.calls[0].body.request_id);
  await page.reload();
  dialog = await openChat(page);
  await expect(dialog.locator('.chatbot-user')).toHaveCount(0);
  await sendChat(page, 'Tin sau tải lại trang.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[2].body.session_id).toBeUndefined();
  expectOnlyMockedApis(state);
});

test('đăng nhập và đăng xuất tách cuộc trò chuyện khách, tài khoản A và B', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL });
  await page.goto('/');
  let dialog = await openChat(page);
  await sendChat(page, 'Nội dung riêng của khách.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  await loginChatUser(page, 'a');
  dialog = await openChat(page);
  await expect(dialog).not.toContainText('Nội dung riêng của khách.');
  await sendChat(page, 'Nội dung riêng tài khoản A.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[1].authorization).toBe(`Bearer ${tokenFor('a')}`);
  expect(state.calls[1].body.session_id).toBeUndefined();
  await sendChat(page, 'Câu tiếp của A.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(2);
  expect(state.calls[2].body.session_id).toBe(sessionFor('a'));
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  dialog = await openChat(page);
  await expect(dialog).not.toContainText('Nội dung riêng tài khoản A.');
  await sendChat(page, 'Khách sau đăng xuất.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[3].authorization).toBeUndefined();
  expect(state.calls[3].body.session_id).toBeUndefined();
  await loginChatUser(page, 'b');
  dialog = await openChat(page);
  await expect(dialog).not.toContainText('Nội dung riêng tài khoản A.');
  await expect(dialog).not.toContainText('Khách sau đăng xuất.');
  await sendChat(page, 'Tin riêng tài khoản B.');
  await expect(dialog.locator('.chatbot-assistant')).toHaveCount(1);
  expect(state.calls[4].authorization).toBe(`Bearer ${tokenFor('b')}`);
  expect(state.calls[4].body.session_id).toBeUndefined();
  expectOnlyMockedApis(state);
});

test('tài khoản admin không gửi chatbot dưới quyền khách', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, owner: 'admin' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Mở AI Chatbot', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Chatbot PetCareShop' });
  await expect(dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true })).toBeDisabled();
  await expect(dialog).toContainText(/khách hàng|quản trị/i);
  expect(state.calls).toEqual([]);
  expectOnlyMockedApis(state);
});

test('401 không tự hạ quyền thành khách hoặc gửi lại bằng token khác', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, owner: 'a', onChat: () => ({
    status: 401, body: { success: false, message: 'Invalid or expired token' },
  }) });
  await page.goto('/');
  const dialog = await openChat(page);
  await sendChat(page, 'Tin tài khoản đã hết hạn.');
  await expect(dialog.getByRole('link', { name: 'Đăng nhập lại để tiếp tục', exact: true })).toHaveAttribute('href', '/login?returnTo=%2F');
  await expect(dialog.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' })).toBeDisabled();
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].authorization).toBe(`Bearer ${tokenFor('a')}`);
  expectOnlyMockedApis(state);
});

test('grounding fallback hoàn tất được hiển thị như phản hồi backend, không tự sinh sản phẩm', async ({ page, baseURL }) => {
  const state = await mockChatbot(page, { frontendOrigin: baseURL, onChat: ({ body }) => ({ body: chatReply(body, {
    code: 'GROUNDING_REJECTED', message: 'Mình chưa thể xác nhận gợi ý vừa nhận được.', products: [], follow_up: 'Bạn mô tả rõ hơn nhu cầu nhé.',
  }) }) });
  await page.goto('/');
  const dialog = await openChat(page);
  await sendChat(page, 'Tư vấn sản phẩm phù hợp với mèo con.');
  await expect(dialog.locator('.chatbot-assistant')).toContainText('Mình chưa thể xác nhận gợi ý vừa nhận được.');
  await expect(dialog.locator('.chatbot-product-card')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Nội dung tin nhắn' })).toBeEnabled();
  expectOnlyMockedApis(state);
});
