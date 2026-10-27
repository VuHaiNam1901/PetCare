const { createProductRepository, normalizeText, validateFilters, searchTerms } = require('./products');
const { measureSync } = require('./metrics');
const LIMITS = Object.freeze({ message: 2000, products: 6, description: 800, bytes: 16000, history: 8, historyText: 400, historyBytes: 2400 });
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_SEARCH' }); };
const FOLLOW_UP = /\b(loai do|cai do|san pham do|loai nay|cai nay|loai ay|(?:loai|mon|san pham|cai) dau tien|loai nao re nhat|con nao re nhat|phu hop|con khong)\b/;
const PRICE_STOCK = /\b(gia|bao nhieu tien|ton kho|con hang|het hang|con khong)\b/;
const CARE = /\b(cham soc|dinh duong|ve sinh|hanh vi|huan luyen|cho an|nen an|an gi|cach nuoi|nuoi cho|nuoi meo|can do|sua nhieu|sua qua|sua lien tuc|may bua|bao nhieu bua|tam|suc khoe|stress|bo an|non|tieu chay|kho tho|hon me|co giat|ngo doc|bac si|thu y)\b/;
const PRODUCT = /\b(thuc an|thu can|hat|pate|pa te|snack|banh thuong|do choi|dochoi|dau ca|omega|sua tam|vong co|day dat|cat ve sinh|san pham|mua|tim|ngan sach)\b/;
const SHOPPING = /\b(shop|cua hang|co ban|con ban|ben minh co|ben ban co|mua|tim|goi y|gia|con hang)\b/;
const GREETING = /\b(xin chao|chao ban|chao|hello|hi|cam on|tam biet|ban la ai|hen gap lai)\b/;
const CARE_QUESTION = /\b(tai sao|lam sao|cach nuoi|nen lam gi|co nen|can phai lam gi)\b/;

function classifyIntent(message, filters = {}, history = []) {
    const query = normalizeText(message);
    if (/\b(so sanh|khac nhau|tot hon|giua hai|giua cac)\b/.test(query)) return 'compare';
    if (PRICE_STOCK.test(query) && !/\b(gia dinh|gia do)\b/.test(query)) return 'price_stock';
    if (history.length && FOLLOW_UP.test(query)) return 'follow_up';
    if (/\b(tu van|goi y|phu hop|nen mua|nen chon)\b/.test(query) && (PRODUCT.test(query) || !CARE.test(query))) return 'product_advice';
    if ((CARE.test(query) || CARE_QUESTION.test(query)) && !SHOPPING.test(query)) return 'care';
    if (GREETING.test(query) && !SHOPPING.test(query) && !PRODUCT.test(query)) return 'care';
    if (SHOPPING.test(query) || /^co\s+.+\s+khong$/.test(query)) return 'product_search';
    if (/\b(?:duoi|toi da|khong qua|khoang|ngan sach|tu|tren|it nhat)\s*\d/.test(query)) return 'product_search';
    if (Object.keys(filters).some(key => !['limit', 'sort'].includes(key)) || PRODUCT.test(query) || /\b(re nhat|dat nhat)\b/.test(query)) return 'product_search';
    // Catalog names have no dependable vocabulary: a short name fragment can
    // be looked up directly unless it already expressed care or a greeting.
    if (query.split(' ').length <= 6 && searchTerms(message).length) return 'product_search';
    return 'care';
}

function amount(raw, unit) {
    let numeric = raw;
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(numeric)) numeric = numeric.replace(/[.,]/g, '');
    else numeric = numeric.replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(numeric)) return null;
    const [whole, fraction = ''] = numeric.split('.');
    const multiplier = /^(?:tr|trieu)$/.test(unit || '') ? 1000000n : /^(?:k|nghin|ngan)$/.test(unit || '') ? 1000n : 1n;
    const cents = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * multiplier;
    if (cents > 999999999999n) return null;
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function inferSearch(message) {
    let query = message.normalize('NFC');
    // Vietnamese NFC characters fold one-to-one, preserving budget positions.
    const folded = query.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const value = '(\\d+(?:[.,]\\d+)*)(?:\\s*(trieu|nghin|ngan|tr|k|vnd|dong|d))?';
    const range = new RegExp('\\b(?:(tu|khoang|tam|ngan sach(?: khoang)?)\\s+)?' + value + '\\s*(?:den|toi|[-–—])\\s*' + value + '(?![a-z0-9])', 'i').exec(folded);
    const validRange = range && (range[1] || range[3] || range[5]) ? range : null;
    const upper = new RegExp('\\b(?:duoi|toi da|khong qua|ngan sach(?: (?:la|khoang|tam))?)\\s*' + value + '(?![a-z0-9])', 'i').exec(folded);
    const lower = new RegExp('\\b(?:tren|it nhat|tu)\\s*' + value + '(?![a-z0-9])', 'i').exec(folded);
    const filters = {};
    const match = validRange || upper || lower;
    if (match) {
        if (validRange) {
            // A trailing shared unit applies to both ends: 100–300 nghìn.
            filters.minPrice = amount(match[2], match[3] || match[5]);
            filters.maxPrice = amount(match[4], match[5] || match[3]);
        } else filters[upper ? 'maxPrice' : 'minPrice'] = amount(match[1], match[2]);
        if (Object.values(filters).some(bound => bound === null)) invalid('Unrecognized price range');
        query = query.slice(0, match.index) + ' ' + query.slice(match.index + match[0].length);
    }
    if (/\b(re nhat|gia thap nhat|gia tang dan|tu re den dat)\b/.test(folded)) filters.sort = 'price_asc';
    else if (/\b(dat nhat|gia cao nhat|gia giam dan)\b/.test(folded)) filters.sort = 'price_desc';
    if (/\b(re nhat|gia thap nhat|dat nhat|gia cao nhat)\b/.test(folded)) filters.limit = 1;
    query = query.replace(/\s+/g, ' ').trim();
    if (searchTerms(query).length) filters.query = query.slice(0, 300);
    return filters;
}

function isUrgent(message) {
    const folded = message.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const clauses = folded.split(/[.!?;,\n]|\b(?:nhung|tuy nhien|ma lai)\b/);
    for (const clause of clauses) {
        const normalized = normalizeText(clause);
        const dangers = /\b(khong tho(?: duoc)?|ngung tho|kho tho|hon me|co giat|ngo doc|bat tinh|chay mau nhieu|khong dung duoc)\b/g;
        for (const match of normalized.matchAll(dangers)) {
            const prefix = normalized.slice(0, match.index);
            if (!/\b(?:khong|chua|chang)(?:\s+(?:bi|co|phai|con|he|dau hieu|trieu chung))*\s*$/.test(prefix)) return true;
        }
    }
    return false;
}

function boundedHistory(history) {
    if (!Array.isArray(history)) invalid('Invalid conversation history');
    const entries = history.slice(-LIMITS.history).filter(entry => entry && ['user', 'assistant'].includes(entry.role) && typeof entry.text === 'string').map(entry => {
        const item = { role: entry.role, text: entry.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, LIMITS.historyText) };
        if (Array.isArray(entry.product_ids)) item.product_ids = [...new Set(entry.product_ids.filter(id => Number.isInteger(id) && id > 0 && id <= 2147483647))].slice(0, 24);
        if (entry.search) {
            try { item.search = validateFilters(entry.search); } catch { /* Ignore invalid persisted metadata. */ }
        }
        return item;
    });
    // The server owns history provenance; this is only a size/shape boundary.
    while (entries.length && Buffer.byteLength(JSON.stringify(entries.map(({ role, text }) => ({ role, text }))), 'utf8') > LIMITS.historyBytes) entries.shift();
    return entries;
}

function resolvedSearch(message, filters, history) {
    const inferred = inferSearch(message);
    const folded = normalizeText(message);
    const previous = [...history].reverse().find(entry => entry.search)?.search;
    const assistant = [...history].reverse().find(entry => entry.role === 'assistant' && entry.product_ids?.length);
    const cheapest = /\b(re nhat|gia thap nhat|dat nhat|gia cao nhat)\b/.test(folded);
    const listedOnly = /\btrong (?:nhung|cac) (?:loai|san pham|lua chon) (?:do|nay)\b/.test(folded);
    const followUp = FOLLOW_UP.test(folded) || /\b(so sanh|khac nhau)\b/.test(folded);
    let resolved = inferred;
    if (previous && (followUp || cheapest)) {
        resolved = { ...previous, ...inferred };
        // Pronouns and age follow-ups refer to the previous search; their new
        // wording is useful to the assistant, not a replacement catalog query.
        if (previous.query) resolved.query = previous.query;
        if (previous.keywords) resolved.keywords = previous.keywords;
    }
    if (assistant && followUp && !cheapest) {
        resolved.productIds = /\b(?:loai|mon|san pham|cai) dau tien\b/.test(folded) ? assistant.product_ids.slice(0, 1) : assistant.product_ids;
        // Existing selected IDs are authoritative for this reference. A new
        // suitability question must not hide them with incidental text terms.
        delete resolved.query;
        resolved.keywords = [];
    }
    // Unqualified cheapest searches the earlier catalog filter. An explicit
    // reference to the listed choices compares only those displayed cards.
    if (cheapest && listedOnly && assistant) resolved.productIds = assistant.product_ids;
    else if (cheapest && previous) delete resolved.productIds;
    return validateFilters({ ...resolved, ...filters });
}

function safeProduct(row) {
    return {
        product_id: row.product_id, category_id: row.category_id,
        name: String(row.name ?? '').slice(0, 150), category_name: String(row.category_name ?? '').slice(0, 100),
        price: row.price, stock_quantity: row.stock_quantity,
        description: row.description == null ? null : String(row.description).slice(0, LIMITS.description),
        description_truncated: row.description != null && String(row.description).length > LIMITS.description,
        image_url: row.image_url == null ? null : String(row.image_url).slice(0, 500), status: row.status
    };
}

async function buildContext({ message, mode = 'auto', filters = {}, repository = createProductRepository(), history = [] }) {
    // Keep context/history construction separate from the awaited catalog work.
    const { conversation, intent, context } = measureSync('context_history_ms', () => {
        if (typeof message !== 'string' || !message.trim() || [...message].length > LIMITS.message || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)) invalid('Message must contain 1-2000 text characters');
        if (!['auto', 'product', 'care'].includes(mode)) invalid('Unsupported assistant mode');
        validateFilters(filters);
        const conversation = boundedHistory(history);
        let intent = classifyIntent(message, filters, conversation);
        const urgent = isUrgent(message);
        const selectedMode = urgent || mode === 'care' || (mode === 'auto' && intent === 'care') ? 'care' : 'product';
        if (selectedMode === 'care') intent = 'care';
        else if (intent === 'care') intent = 'product_search';
        const context = { mode: selectedMode, intent, urgent, catalogStatus: 'not_requested', products: [], totalMatches: 0, catalogLimited: false, contextLimited: false };
        if (context.mode === 'product') context.search = resolvedSearch(message, filters, conversation);
        return { conversation, intent, context };
    });
    if (context.mode === 'product') {
        try {
            const result = await repository.search(context.search, { includeOutOfStock: intent === 'price_stock' });
            measureSync('context_history_ms', () => {
                context.products = result.products.filter(row => row.status === 'Đang bán' && (intent === 'price_stock' || row.stock_quantity > 0)).slice(0, LIMITS.products).map(safeProduct);
                context.totalMatches = result.totalMatches;
                context.catalogLimited = Boolean(result.catalogLimited);
                context.contextLimited = result.products.length > LIMITS.products || result.totalMatches > context.products.length || context.products.some(product => product.description_truncated);
                context.catalogStatus = context.products.length ? 'ok' : 'empty';
            });
        } catch (error) {
            if (error.code === 'INVALID_SEARCH') throw error;
            context.catalogStatus = 'unavailable';
        }
    }
    return measureSync('context_history_ms', () => {
        function payload() {
            return {
                mode: context.mode, intent: context.intent, user_request: message.trim(),
                // The current resolved search is sufficient for the model. Keeping
                // old search metadata internal avoids duplicating large filters.
                history: conversation.map(({ role, text, product_ids }) => ({ role, text, ...(product_ids ? { product_ids } : {}) })),
                ...(context.search ? { search: context.search } : {}),
                // Cards retain SQL images; the model selects IDs and needs no URL.
                catalog: { source: 'MySQL', status: context.catalogStatus, products: context.products.map(({ image_url, ...product }) => product),
                    limited: context.catalogLimited || context.contextLimited,
                    missing_attributes: ['age_range', 'breed', 'health_suitability', 'promotion', 'brand_column'] }
            };
        }
        context.payload = payload();
        while (Buffer.byteLength(JSON.stringify(context.payload), 'utf8') > LIMITS.bytes && (conversation.length || context.products.length)) {
            if (conversation.length) conversation.shift();
            else context.products.pop();
            context.contextLimited = true;
            context.payload = payload();
        }
        if (!context.products.length && context.catalogStatus === 'ok') {
            context.catalogStatus = 'empty';
            context.payload = payload();
        }
        if (Buffer.byteLength(JSON.stringify(context.payload), 'utf8') > LIMITS.bytes) invalid('Context exceeds byte limit');
        return context;
    });
}
module.exports = { buildContext, classifyIntent, inferSearch, LIMITS, isUrgent };
