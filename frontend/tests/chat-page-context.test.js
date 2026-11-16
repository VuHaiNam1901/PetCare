import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatPageContext, customerChatRoute, sanitizeChatPageState } from '../src/utils/chat-page-context.js';
import { sendChatMessage } from '../src/services/chat.js';

test('page context: browser snapshot follows cart, selected quantity and owner, excluding personal data', () => {
  const commerce = { user: { user_id: 7, role: 'user', email: 'PRIVATE' }, cart: { items: [
    { product_id: 12, selected: true, available: true, status: 'Đang bán', quantity: 2, stock_quantity: 3, name: 'PRIVATE' },
    { product_id: 13, selected: true, available: false, quantity: 1, stock_quantity: 0 },
  ] }, mergeCanEdit: true };
  const entry = { route: '/products/12', owner: 7, state: { phase: 'ready', quantity: 2, password: 'PRIVATE', can_cancel: true } };
  const context = buildChatPageContext(commerce, entry, '/products/12');
  assert.equal(context.cart.item_count, 2);
  assert.equal(context.cart.selected_count, 1);
  assert.equal(context.cart.editable_quantity_count, 1);
  assert.deepEqual(context.state, { phase: 'ready', quantity: 2 });
  assert.equal(JSON.stringify(context).includes('PRIVATE'), false);
  assert.deepEqual(buildChatPageContext(commerce, entry, '/cart').state, { phase: 'ready' });
  assert.deepEqual(buildChatPageContext({ ...commerce, user: null }, entry, '/products/12').state, {});
  assert.equal(buildChatPageContext(commerce, entry, '/admin/orders'), undefined);
  assert.equal(buildChatPageContext({ ...commerce, user: { role: 'admin' } }, entry, '/cart'), undefined);
  assert.equal(customerChatRoute('/products/12?password=PRIVATE'), null);
  assert.deepEqual(sanitizeChatPageState({ shipping_invalid: ['phone', 'PRIVATE'], address: 'PRIVATE', token: 'PRIVATE' }), { shipping_invalid: ['phone'] });
});

test('page context: chat service transmits optional sanitized observations and keeps the old contract', async t => {
  const request_id = '4e55c407-9b05-4d61-83b2-dc5902fabdc9';
  const session_id = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, request_id, session_id, code: 'OK', message: 'Bạn xem hướng dẫn nhé.', products: [], warnings: [], follow_up: null, replayed: false }), { status: 200 });
  });
  const request = { message: 'Tiếp theo làm gì?', request_id };
  await sendChatMessage({ ...request, page_context: { version: 1, route: '/checkout', state: { phase: 'ready', shipping_invalid: ['phone'], password: 'PRIVATE' }, cart: { item_count: 2, token: 'PRIVATE' }, user_id: 7 } });
  assert.deepEqual(sent.page_context, { version: 1, route: '/checkout', cart: { item_count: 2 }, state: { phase: 'ready', shipping_invalid: ['phone'] } });
  await sendChatMessage(request);
  assert.deepEqual(sent, request);
});
