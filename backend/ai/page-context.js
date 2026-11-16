'use strict';

const { normalizeText } = require('./products');
const MAX_BYTES = 4096;
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw Object.assign(new Error('Ngữ cảnh trang không hợp lệ.'), { code: 'INVALID_PAGE_CONTEXT', status: 400, chatSafe: true }); };
const statuses = ['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'];
const pages = {
    '/': ['home', 'Trang chủ'], '/products': ['products', 'Danh sách sản phẩm'], '/cart': ['cart', 'Giỏ hàng'],
    '/checkout': ['checkout', 'Đặt hàng'], '/login': ['login', 'Đăng nhập'], '/register': ['register', 'Đăng ký'],
    '/profile': ['profile', 'Thông tin cá nhân'], '/my-orders': ['orders', 'Đơn hàng của tôi'], '/wishlist': ['wishlist', 'Sản phẩm yêu thích'],
};
const fields = {
    home: ['search_active', 'category_id', 'pet_filter_active', 'sort', 'page', 'category_filter_visible', 'pet_filter_visible', 'reset_visible', 'can_load_more'],
    products: ['search_active', 'category_id', 'pet_filter_active', 'sort', 'page', 'category_filter_visible', 'pet_filter_visible', 'reset_visible', 'can_load_more'],
    product: ['quantity', 'purchase_disabled', 'quantity_disabled'], cart: [], login: [], register: [], profile: ['editing'],
    checkout: ['has_draft', 'form_visible', 'shipping_invalid', 'payment_method', 'locked', 'pending_submission', 'confirming',
        'submit_disabled', 'preview_loading', 'products_unavailable', 'preview_error', 'storage_error', 'completed',
        'voucher_visible', 'voucher_selected', 'voucher_needs_check', 'voucher_busy', 'voucher_disabled'],
    orders: ['status_filter', 'page', 'has_orders'], order: ['cancel_dialog', 'cancel_error', 'cancel_visible', 'cancel_reason_valid'],
    review: ['reviewed', 'review_blocked'], reviews: ['page'], wishlist: ['has_items'],
};
const enums = { phase: ['loading', 'ready', 'error', 'not_found'], sort: ['newest', 'price-asc', 'price-desc'],
    payment_method: ['COD', 'ONLINE'], status_filter: ['', ...statuses] };
const resolved = new WeakSet();

function pageForRoute(path) {
    if (typeof path !== 'string' || path.length > 160) return null;
    const route = path.replace(/\/+$/, '') || '/';
    if (Object.hasOwn(pages, route)) return { key: pages[route][0], name: pages[route][1], route };
    let match = route.match(/^\/products\/([1-9]\d*)(\/reviews)?$/);
    if (match && positive(Number(match[1]))) return { key: match[2] ? 'reviews' : 'product',
        name: match[2] ? 'Đánh giá sản phẩm' : 'Chi tiết sản phẩm', route, product_id: Number(match[1]) };
    match = route.match(/^\/my-orders\/([1-9]\d*)(?:\/review\/([1-9]\d*))?$/);
    if (match && positive(Number(match[1])) && (!match[2] || positive(Number(match[2])))) return {
        key: match[2] ? 'review' : 'order', name: match[2] ? 'Đánh giá sản phẩm' : 'Chi tiết đơn hàng', route,
        order_id: Number(match[1]), ...(match[2] ? { product_id: Number(match[2]) } : {}),
    };
    return null;
}

function normalizePageContext(raw) {
    if (raw === undefined || raw === null) return null;
    if (!object(raw)) invalid();
    // Ignore admin and unknown routes without inspecting any page state.
    const page = pageForRoute(raw.route);
    if (!page) return null;
    if (raw.version !== 1 || Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_BYTES) invalid();
    if ((raw.cart !== undefined && !object(raw.cart)) || (raw.state !== undefined && !object(raw.state))) invalid();
    const cart = {}, state = {};
    for (const key of ['item_count', 'selected_count', 'selectable_count', 'editable_quantity_count', 'loading', 'error', 'busy', 'merging', 'merge_can_edit']) {
        if (!Object.hasOwn(raw.cart || {}, key)) continue;
        const value = raw.cart[key];
        if (key.endsWith('_count') ? !Number.isSafeInteger(value) || value < 0 || value > 100 : typeof value !== 'boolean') invalid();
        cart[key] = value;
    }
    if (cart.selected_count > cart.item_count) invalid();
    if (cart.selectable_count > cart.item_count || cart.editable_quantity_count > cart.item_count || cart.selected_count > cart.selectable_count) invalid();
    for (const key of ['phase', 'busy', ...fields[page.key]]) {
        if (!Object.hasOwn(raw.state || {}, key)) continue;
        const value = raw.state[key];
        if (key === 'shipping_invalid') {
            if (!Array.isArray(value) || value.length > 4 || value.some(field => !['recipient_name', 'phone', 'address', 'note'].includes(field))) invalid();
            state[key] = [...new Set(value)];
        } else {
            if (Object.hasOwn(enums, key) ? !enums[key].includes(value) : ['quantity', 'category_id', 'page'].includes(key) ? !positive(value) : typeof value !== 'boolean') invalid();
            state[key] = value;
        }
    }
    return { version: 1, route: page.route, cart, state };
}

function actionsFor(context) {
    const { page, state: s, cart, auth, product, order, review } = context;
    const ready = s.phase === undefined ? null : s.phase === 'ready';
    const actions = [];
    const add = (id, label, visible = ready, enabled = visible, reason = null) => actions.push({ id, label, visible, enabled: visible === false ? false : enabled, ...(reason ? { reason } : {}) });
    const idle = s.busy !== true && cart.busy !== true;
    if (['home', 'products'].includes(page.key)) {
        add('search', 'Tìm kiếm', true, true);
        add('search_field', 'Tìm kiếm sản phẩm', true, true);
        add('category_filter', 'Tất cả', s.category_filter_visible ?? null, true);
        add('pet_filter', 'Mua sắm theo thú cưng', s.pet_filter_visible ?? null, true);
        add('sort', 'Sắp xếp sản phẩm', true, true);
        add('reset', 'Xóa bộ lọc', s.reset_visible ?? null, true);
        add('load_more', 'Xem thêm sản phẩm', s.can_load_more ?? null, true);
    } else if (page.key === 'product') {
        const available = product?.verification === 'verified' ? product.available : null;
        const purchasable = ready === true && available === true && idle && s.purchase_disabled === false;
        add('quantity', 'Số lượng', ready, ready === true && available === true && s.quantity_disabled === false);
        add('add_to_cart', 'Thêm vào giỏ hàng', ready, purchasable, !available ? 'product_unavailable_or_unverified' : !idle ? 'busy' : null);
        add('buy_now', 'Mua ngay', ready, purchasable);
        add('read_reviews', 'Xem đánh giá', ready, ready);
    } else if (page.key === 'cart') {
        const loaded = cart.loading === false && cart.error === false;
        const occupied = loaded && cart.item_count > 0;
        const editable = occupied && idle && (!cart.merging || cart.merge_can_edit === true);
        add('select', 'Chọn tất cả', occupied, editable && cart.selectable_count > 0);
        add('quantity', 'Số lượng', occupied, editable && cart.editable_quantity_count > 0);
        add('remove', 'Xóa', occupied, editable);
        add('checkout', 'Đặt hàng', occupied, occupied && idle && cart.selected_count > 0 && cart.merging === false,
            cart.merging ? 'merge_required' : !cart.selected_count ? 'select_available_items_first' : null);
        add('retry_merge', 'Thử đồng bộ lại', cart.merging === true, idle);
        add('continue_shopping', 'Tiếp tục mua sắm', true, true);
    } else if (page.key === 'checkout') {
        const form = ready === true && auth.authenticated && s.form_visible === true;
        add('shipping', 'Thông tin nhận hàng', form, form && s.locked === false);
        add('payment', 'Phương thức thanh toán', form, form && s.locked === false);
        add('confirm', 'Xác nhận đặt hàng', form && s.pending_submission === false && s.completed === false, form && s.submit_disabled === false);
        add('retry_submission', 'Thử lại đặt hàng', form && s.pending_submission === true && !s.confirming, form && s.submit_disabled === false);
        add('voucher', 'Chọn Voucher', form && s.voucher_visible === true, form && s.voucher_disabled === false);
    } else if (['login', 'register'].includes(page.key)) {
        add('authenticate', page.name, ready === true && !auth.authenticated, idle);
        add('switch_auth', page.key === 'login' ? 'Đăng ký' : 'Đăng nhập', ready === true && !auth.authenticated, true);
    } else if (page.key === 'profile') {
        add('edit_profile', 'Chỉnh sửa', ready === true && auth.authenticated && s.editing === false, idle);
        add('save_profile', 'Lưu thay đổi', ready === true && auth.authenticated && s.editing === true, idle);
        add('cancel_edit', 'Hủy', ready === true && auth.authenticated && s.editing === true, idle);
    } else if (page.key === 'orders') {
        add('status_filter', 'Trạng thái đơn hàng', auth.authenticated, true);
        add('view_order', 'Xem chi tiết', ready === true && s.has_orders === true, true);
    } else if (page.key === 'order') {
        const verified = order?.verification === 'verified';
        const shown = ready === true && verified;
        add('refresh_order', 'Cập nhật trạng thái', shown, !s.busy);
        add('cancel_order', 'Hủy đơn hàng', shown && order.can_cancel === true && s.cancel_visible === true, !s.busy,
            !verified ? 'order_unverified' : !order.can_cancel ? 'not_cancellable' : null);
        add('confirm_cancel', 'Xác nhận hủy đơn', shown && order.can_cancel === true && s.cancel_dialog === true, !s.busy && !s.cancel_error && s.cancel_reason_valid === true,
            'choose_cancellation_reason_in_dialog_first');
        add('review_product', 'Đánh giá sản phẩm', shown && order.status === 'Đã giao hàng', true);
    } else if (page.key === 'review') {
        add('submit_review', 'Gửi đánh giá', ready === true && review?.verification === 'verified' && review.can_review === true && s.reviewed === false && s.review_blocked === false, !s.busy);
    } else if (page.key === 'reviews') {
        add('filter_rating', 'Lọc đánh giá theo số sao', ready, ready);
    } else if (page.key === 'wishlist') {
        add('continue_shopping', 'Tiếp tục mua sắm', true, true);
        add('wishlist', 'Bỏ yêu thích', ready === true && auth.authenticated && s.has_items === true, idle);
    }
    return actions;
}

async function resolvePageContext(raw, { userId = null,
    loadOrder = (owner, id) => require('../models/order').get(owner, id),
    loadProduct = async id => (await require('./products').createProductRepository().getByIds([id]))[0],
    hasReview = async (owner, id) => {
        const [rows] = await require('../config/db').execute('SELECT review_id FROM reviews WHERE user_id = ? AND product_id = ? LIMIT 1', [owner, id]);
        return rows.length > 0;
    } } = {}) {
    const input = normalizePageContext(raw);
    if (!input) return null;
    const page = pageForRoute(input.route);
    const context = { version: 1, page, auth: { authenticated: positive(userId), source: 'server_authentication' },
        cart: input.cart, state: input.state, observation_source: 'untrusted_client_ui_only', ephemeral: true };
    if (['product', 'reviews'].includes(page.key)) {
        context.product = { verification: 'unavailable' };
        try {
            const product = await loadProduct(page.product_id);
            if (product?.product_id === page.product_id && product.status === 'Đang bán' && Number.isSafeInteger(Number(product.stock_quantity))) {
                context.product = { verification: 'verified', product_id: product.product_id,
                    available: Number(product.stock_quantity) > 0 && (!input.state.quantity || input.state.quantity <= Number(product.stock_quantity)) };
            }
        } catch { /* Unknown inventory never enables a purchase recommendation. */ }
    }
    if (page.order_id) {
        context.order = { verification: context.auth.authenticated ? 'unavailable' : 'authentication_required' };
        if (context.auth.authenticated) {
            try {
                const order = await loadOrder(userId, page.order_id);
                if (order?.user_id === userId && order.order_id === page.order_id && statuses.includes(order.status) && typeof order.can_cancel === 'boolean') {
                    context.order = { verification: 'verified', order_id: order.order_id, status: order.status,
                        approval_state: ['pending', 'approved', 'rejected', 'cancelled', 'awaiting_payment', 'legacy'].includes(order.approval_state) ? order.approval_state : null,
                        can_cancel: order.can_cancel === true, source: 'owned_order_backend' };
                    if (page.key === 'review') {
                        const purchased = order.items?.some(item => item.product_id === page.product_id && item.quantity > 0) === true;
                        context.review = { verification: 'verified', can_review: purchased && order.status === 'Đã giao hàng' && !(await hasReview(userId, page.product_id)) };
                    }
                }
            } catch { /* Do not reveal whether an unowned order exists, or any DB error. */ }
        }
    }
    context.ui = { actions: actionsFor(context) };
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(context);
    resolved.add(context);
    return context;
}

const isResolvedPageContext = value => value != null && resolved.has(value);

function validatePageProse(text, context) {
    if (!isResolvedPageContext(context)) return;
    const reject = () => { throw new Error('Unverified website instruction'); };
    for (const raw of text.split(/[.!?;\n]+|\b(?:nhưng|tuy nhiên)\b/iu)) {
        const clause = normalizeText(raw);
        if (context.order?.verification === 'verified' && context.order.can_cancel === false &&
            /\bban\b.{0,30}\b(?:co the huy|van duoc huy)\b/.test(clause) && !/\b(?:khong|chua)\b/.test(clause)) reject();
        for (const action of context.ui.actions) {
            if (action.visible !== false && action.enabled !== false) continue;
            const label = normalizeText(action.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const instruction = new RegExp(`\\b(?:nhan|bam|chon|su dung)\\s+(?:(?:nut|muc|o)\\s+)?${label}(?:\\b|$)`, 'g');
            for (const match of clause.matchAll(instruction)) {
                if (!/\b(?:khong|chua|dung|cho)\b/.test(clause.slice(Math.max(0, match.index - 35), match.index))) reject();
            }
        }
        const subject = /\bdon(?: hang)? (?:nay|cua ban|dang xem)\b/.exec(clause);
        const conditional = /\b(?:neu|khi|chua the xac nhan|khong the xac nhan)\b/.test(clause.slice(0, subject?.index ?? 0));
        if (subject && !conditional) {
            if (context.order?.verification !== 'verified') {
                if (/\b(?:da|dang|du dieu kien|co the huy)\b/.test(clause.slice(subject.index))) reject();
            } else {
                if (context.order.can_cancel === false && /\b(?:co the huy|duoc huy|du dieu kien huy)\b/.test(clause) && !/\b(?:khong|chua)\b/.test(clause)) reject();
                for (const status of statuses) {
                    if (status !== context.order.status && clause.includes(normalizeText(status))) reject();
                }
                if (context.order.approval_state !== 'approved' && /\bda (?:duoc )?duyet\b/.test(clause) && !/\b(?:khong|chua)\b/.test(clause)) reject();
            }
        }
    }
}

module.exports = { MAX_BYTES, pageForRoute, normalizePageContext, resolvePageContext, isResolvedPageContext, validatePageProse };
