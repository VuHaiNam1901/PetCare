'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizePageContext, resolvePageContext, isResolvedPageContext } = require('../ai/page-context');
const { createOrchestrator } = require('../ai/orchestrator');
const { validatePlan } = require('../ai/grounding');
const { getWebsiteGuides } = require('../ai/website-knowledge');
const core = require('../ai/memory');

const observation = (route, state = {}, cart = {}) => ({ version: 1, route, state, cart });
const action = (context, id) => context.ui.actions.find(item => item.id === id);
const order = (changes = {}) => ({ user_id: 7, order_id: 23, status: 'Chờ giao hàng', approval_state: 'approved', can_cancel: false, items: [], ...changes });
const validate = (advice, context, topics) => validatePlan({ text: JSON.stringify({ advice, product_ids: [], follow_up: null, warnings: [] }), candidates: [{ finishReason: 'STOP' }] },
    { mode: 'care', intent: 'website_help', products: [], page_context: context, website_guides: getWebsiteGuides({ topics }).guides });
const modelCall = (name, args) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args } }] } }], usageMetadata: { totalTokenCount: 100 } });

test('page context: bounded allowlists strip private/authority fields and ignore admin or unknown pages', () => {
    const raw = { ...observation('/products/12/', { phase: 'ready', quantity: 2, can_cancel: true, password: 'PRIVATE' }),
        user_id: 7, token: 'PRIVATE', ui: { label: 'Invented' }, cart: { item_count: 1, selected_count: 0, items: ['PRIVATE'] } };
    assert.deepEqual(normalizePageContext(raw), observation('/products/12', { phase: 'ready', quantity: 2 }, { item_count: 1, selected_count: 0 }));
    for (const route of ['/admin', '/admin/orders/23', '/not-a-page', '/products/12?token=PRIVATE', '/products/2147483648']) assert.equal(normalizePageContext(observation(route)), null);
    for (const raw of [[], observation('/cart', {}, { item_count: -1 }), observation('/cart', {}, { item_count: 1, selected_count: 2 }),
        observation('/products/12', { quantity: '2' }), { ...observation('/cart'), version: 2 }, { ...observation('/cart'), junk: 'x'.repeat(4096) }]) {
        assert.throws(() => normalizePageContext(raw), { code: 'INVALID_PAGE_CONTEXT' });
    }
});

test('page context: product quantity and cart controls follow the current UI with fresh stock evidence', async () => {
    const context = await resolvePageContext(observation('/products/12', { phase: 'ready', quantity: 2, purchase_disabled: false, quantity_disabled: false }),
        { loadProduct: async id => ({ product_id: id, status: 'Đang bán', stock_quantity: 4 }) });
    assert.equal(context.page.product_id, 12);
    assert.equal(action(context, 'buy_now').enabled, true);
    assert.equal(validate('Bạn đang chọn 2 sản phẩm. Nhấn "Mua ngay" để tiếp tục với sản phẩm đang xem.', context, ['buy_now']).product_ids.length, 0);
    const unavailable = await resolvePageContext(observation('/products/12', { phase: 'ready', purchase_disabled: false }), { loadProduct: async () => { throw Error('PRIVATE'); } });
    assert.equal(action(unavailable, 'buy_now').enabled, false);
    assert.throws(() => validate('Nhấn "Mua ngay" để tiếp tục.', unavailable, ['buy_now']));
    const cart = await resolvePageContext(observation('/cart', {}, { item_count: 2, selected_count: 0, loading: false, error: false, busy: false, merging: false }));
    assert.equal(cart.auth.authenticated, false);
    assert.equal(action(cart, 'checkout').enabled, false);
    assert.throws(() => validate('Nhấn "Đặt hàng" ngay nhé.', cart, ['cart']));
});

test('page context: only the authenticated owner can supply current order state and cancellation rights', async () => {
    const raw = observation('/my-orders/23', { phase: 'ready', cancel_visible: true, can_cancel: true, status: 'Chờ xử lý' });
    let reads = 0;
    const loadOrder = async (owner, id) => { reads++; assert.equal(owner, 7); assert.equal(id, 23); return order(); };
    const guest = await resolvePageContext(raw, { loadOrder });
    assert.equal(reads, 0);
    assert.equal(guest.order.verification, 'authentication_required');
    const current = await resolvePageContext(raw, { userId: 7, loadOrder });
    assert.equal(current.order.status, 'Chờ giao hàng');
    assert.equal(current.order.can_cancel, false);
    assert.equal(action(current, 'cancel_order').visible, false);
    assert.throws(() => validate('Nhấn "Hủy đơn hàng" để hủy.', current, ['order_cancel']));
    assert.throws(() => validatePlan({ text: JSON.stringify({ advice: 'Bạn có thể hủy đơn này.', product_ids: [], follow_up: null, warnings: [] }), candidates: [{ finishReason: 'STOP' }] },
        { mode: 'care', intent: 'conversation', products: [], page_context: current }));
    assert.doesNotThrow(() => validate('Đơn hàng của bạn đang chờ giao hàng, đã được duyệt nên không còn đủ điều kiện hủy. Bạn có thể xem "Theo dõi đơn hàng".', current, ['order_tracking', 'order_cancel']));
    const unowned = await resolvePageContext(raw, { userId: 7, loadOrder: async () => order({ user_id: 8 }) });
    assert.equal(unowned.order.verification, 'unavailable');
    assert.equal(JSON.stringify(unowned).includes('Chờ giao hàng'), false);
});

test('page context: checkout locks and review eligibility never create new transactional capabilities', async () => {
    const context = await resolvePageContext(observation('/checkout', { phase: 'ready', form_visible: true, shipping_invalid: ['phone'],
        locked: true, pending_submission: true, confirming: false, submit_disabled: false }), { userId: 7 });
    assert.equal(action(context, 'shipping').enabled, false);
    assert.equal(action(context, 'confirm').visible, false);
    assert.equal(action(context, 'retry_submission').enabled, true);
    assert.throws(() => validate('Nhấn "Xác nhận đặt hàng" lần nữa.', context, ['checkout']));
    const review = await resolvePageContext(observation('/my-orders/23/review/12', { phase: 'ready', reviewed: false, review_blocked: false }),
        { userId: 7, loadOrder: async () => order({ status: 'Đã giao hàng', items: [{ product_id: 12, quantity: 1 }] }), hasReview: async () => true });
    assert.equal(review.review.can_review, false);
    assert.equal(action(review, 'submit_review').visible, false);
});

test('page context: orchestrator refreshes the current page per turn without persisting it in Memory Core', async () => {
    let rounds = 0;
    let expectedRoute = '/cart';
    const assistant = createOrchestrator({ tools: { execute() { assert.fail('No catalog tool required for website usage'); } },
        async generate({ contents }) {
            const bootstrap = JSON.parse(contents[0].parts[0].text);
            assert.equal(bootstrap.current_page.page.route, expectedRoute);
            if (rounds++ % 2 === 0) return modelCall('get_website_guide', { topics: ['cart', 'checkout'] });
            return modelCall('respond', { mode: 'care', intent: 'website_help', advice: 'Bạn kiểm tra sản phẩm và thông tin nhận hàng trước khi xác nhận nhé.', product_ids: [], follow_up: null, warnings: [] });
        } });
    const first = await assistant.reply({ message: 'Làm sao đặt hàng?', turn_id: 'page:first', page_context: await resolvePageContext(observation('/cart')) });
    expectedRoute = '/checkout';
    const next = await assistant.reply({ message: 'Tôi cần làm gì tiếp?', turn_id: 'page:next', memory: first.memory, page_context: await resolvePageContext(observation('/checkout')) });
    assert.equal(next.memory.recent_history.length, 4);
    assert.deepEqual(core.getActiveContext(next.memory), core.getActiveContext(first.memory));
    assert.equal(core.serializeMemory(next.memory).includes('current_page'), false);
    assert.equal(core.serializeMemory(next.memory).includes('/checkout'), false);
    await assert.rejects(assistant.reply({ message: 'hi', page_context: { order: { can_cancel: true } } }), { code: 'INVALID_SEARCH' });
});

test('page context: real route keeps legacy, replay and auth contracts; current context is never saved', async t => {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const users = require('../models/user');
    const original = users.byId;
    users.byId = async id => ({ user_id: Number(id), role: Number(id) === 99 ? 'admin' : 'user', status: 'active' });
    t.after(() => { users.byId = original; });
    const { createChatRouter } = require('../routes/chat');
    const { createSessionCodec } = require('../ai/sessions');
    const secret = require('../config/auth').secret;
    const records = new Map(), inputs = [];
    let resolutions = 0;
    const store = { async withSession(_access, work) { return work({
        findRequest: async id => records.get(id), loadMemory: async () => core.createMemory(), history: async () => [],
        async savePair(pair) {
            assert.equal(pair.page_context, undefined);
            assert.equal(JSON.stringify(pair.memory || {}).includes('current_page'), false);
            records.set(pair.requestId, { request_hash: pair.hash, response: pair.response });
        },
    }); } };
    const assistant = { async reply(input) { inputs.push(input); return { message: 'Bạn xem hướng dẫn nhé.', products: [], code: 'OK', memory: core.createMemory() }; } };
    const app = express();
    app.use(express.json());
    for (const pipeline of ['legacy', 'orchestrator']) app.use(`/${pipeline}`, createChatRouter({ pipeline, assistant, store, sessionCodec: createSessionCodec(secret),
        pageContextResolver: async (raw, options) => { resolutions++; return resolvePageContext(raw, options); } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (pipeline, body, owner = null) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/${pipeline}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: `Bearer ${jwt.sign({}, secret, { subject: String(owner), expiresIn: '1m' })}` } : {}) }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    const body = { message: 'Làm gì tiếp?', request_id: randomUUID(), page_context: observation('/checkout', { shipping_invalid: ['phone'] }) };
    const first = await post('orchestrator', body, 7);
    assert.equal(first.status, 200);
    assert.equal(isResolvedPageContext(inputs.at(-1).page_context), true);
    assert.equal(inputs.at(-1).page_context.auth.authenticated, true);
    const replay = await post('orchestrator', { ...body, session_id: first.body.session_id }, 7);
    assert.equal(replay.body.replayed, true);
    assert.equal(resolutions, 1);
    assert.equal((await post('legacy', { ...body, request_id: randomUUID() })).status, 200);
    assert.equal(inputs.at(-1).page_context, undefined);
    assert.equal((await post('orchestrator', { ...body, request_id: randomUUID(), page_context: observation('/admin/orders') })).status, 200);
    assert.equal(inputs.at(-1).page_context, undefined);
    assert.equal((await post('orchestrator', { ...body, request_id: randomUUID() }, 99)).status, 403);
    assert.equal((await post('orchestrator', { ...body, page_context: observation('/cart', { phase: 'invented' }) })).status, 400);
});
