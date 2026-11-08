const { createProductRepository, normalizeText, validateFilters, searchTerms } = require('./products');
const { measureSync } = require('./metrics');
const LIMITS = Object.freeze({ message: 2000, products: 6, description: 800, bytes: 16000, history: 8, historyText: 400, historyBytes: 2400 });
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_SEARCH' }); };
const FOLLOW_UP = /\b(loai do|cai do|san pham do|loai nay|cai nay|loai ay|(?:loai|mon|san pham|cai) dau tien|loai nao re nhat|con nao re nhat)\b/;
const PRODUCT_REFERENCE = /\b(?:(?:san pham|loai|cai|mon|lua chon)\s+(?:nay|do|ay|dau tien)|(?:nhung|cac)\s+(?:loai|san pham|lua chon)\s+(?:do|nay))\b/;
const STOCK_QUESTION = /\b(bao nhieu tien|ton kho|con hang|het hang)\b|\bcon khong(?:\s+(?:a|nhi|nhe|shop|oi))*$/;
const CARE = /\b(cham soc|dinh duong|ve sinh|hanh vi|huan luyen|cho an|nen an|an gi|an duoc|an uong|khau phan|thuoc|benh|cach nuoi|nuoi cho|nuoi meo|can do|sua nhieu|sua qua|sua lien tuc|may bua|bao nhieu bua|tam|suc khoe|stress|bo an|non|tieu chay|kho tho|hon me|co giat|ngo doc|bac si|thu y)\b/;
const PRODUCT = /\b(thuc an|thu can|hat|pate|pa te|snack|banh thuong|do choi|dochoi|dau ca|omega|sua tam|vong co|day dat|cat ve sinh|san pham|mua|tim|ngan sach)\b/;
// A shop address or a polite particle is not purchase intent by itself.
const SHOPPING = /\b(co ban|con ban|mua|tim|goi y|con hang)\b/;
const GREETING = /\b(xin chao|chao ban|chao|hello|hi|cam on|tam biet|ban la ai|hen gap lai)\b/;
const CARE_QUESTION = /\b(tai sao|lam sao|cach nuoi|nen lam gi|co nen|can phai lam gi)\b/;

function referenceText(message) {
    // đồ is a noun, whereas đó is a demonstrative. Do not turn "món đồ dùng"
    // into a reference to a previous card merely because accents were folded.
    return normalizeText(message.normalize('NFC').replace(/(?<!\p{L})đồ(?!\p{L})/giu, 'vat dung'))
        .replace(/\bdo(?=\s+(?:dung|choi|an|vat)\b)/g, 'vat dung');
}

function budgetText(message) {
    const raw = message.normalize('NFC').toLowerCase();
    let folded = raw.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd');
    // Keep positions stable so inferSearch can remove only the matched budget
    // from the original text. Explicit bathing and measurements are not VND.
    for (const match of raw.matchAll(/(?<!\p{L})tắm(?!\p{L})/gu)) folded = folded.slice(0, match.index) + 'zzz' + folded.slice(match.index + match[0].length);
    // Mask the whole measured quantity, including ranges. Masking only its
    // prefix would still let the lower-bound parser read "từ 2 đến 3 lần".
    return folded.replace(/\b\d+(?:[.,]\d+)*(?:\s*(?:den|toi|[-–—])\s*\d+(?:[.,]\d+)*)?\s*(?:lan|ngay|tuan|thang|nam|tuoi|gio|phut|kg|g|ml|lit|cm)\b/g, value => 'z'.repeat(value.length));
}

function careQuestion(message) {
    const raw = message.normalize('NFC').toLowerCase();
    const folded = normalizeText(raw);
    const hygieneCare = /\b(?:sua tam|cat ve sinh)\b/.test(folded) &&
        /\b(?:cach|lam sao|nhu the nao|the nao|bao lau|bao nhieu lan|may lan|hang ngay|nen (?:dung|su dung|thay|cho))\b/.test(folded);
    const query = normalizeText(raw.replace(/(?<!\p{L})tầm(?!\p{L})/gu, 'khoang'))
        .replace(/\b(?:sua tam|cat ve sinh)\b/g, ' ')
        .replace(/\btam(?=\s+(?:gia\b|\d+(?:[.,]\d+)*\s*(?:kg|g|ml|lit|cm)\b))/g, 'khoang');
    return hygieneCare || CARE.test(query) || CARE_QUESTION.test(query) ||
        (/\b(?:cho|meo|thu cung)\s+gia\b/.test(query) && !PRODUCT.test(folded) &&
            !/(?<!\p{L})giá(?!\p{L})/u.test(raw) && !/\bgia\s+(?:bao nhieu|hien tai|hom nay|cua)\b/.test(query));
}

function followsProduct(message) {
    const reference = referenceText(message);
    if (/\b(?:tim|mua|chon)\b/.test(reference) && /\b(?:thuc an|hat|pate|snack|do choi|sua tam|cat ve sinh|vong co|day dat|dau ca)\b/.test(normalizeText(message))) return false;
    // A suitability question may omit its subject, but a new product or care
    // topic containing "phù hợp" must not inherit unrelated selected cards.
    return FOLLOW_UP.test(reference) || PRODUCT_REFERENCE.test(reference) ||
        /^(?:(?:shop|oi|minh|ban|co|lieu|no)\s+)*(?:phu hop|con khong)\b/.test(reference);
}

function comparisonSubjects(message) {
    const subjects = normalizeText(message)
        .replace(/\b(?:so sanh|khac nhau|tot hon|giua|hai|cac|san pham|loai|nay|do|cai|mon|dau tien|voi nhau|giup|minh|ban|shop|oi|nhi)\b/g, ' ')
        .split(/\b(?:va|voi|vs|versus|hay|so voi)\b/)
        .map(part => searchTerms(part));
    return subjects.length >= 2 && subjects.filter(terms => terms.length > 0).length >= 2;
}

function categoryQuestion(query) {
    return /\b(?:danh muc|nhom san pham|nhom hang)(?: san pham)?\s+(?:nao|gi)\b/.test(query) ||
        /\b(?:liet ke|danh sach)\s+(?:(?:cac|nhung|tat ca|toan bo)\s+)?(?:danh muc|nhom san pham|nhom hang)\b/.test(query) ||
        /\b(?:xem|co)\s+(?:cac|nhung|tat ca|toan bo)\s+(?:danh muc|nhom san pham|nhom hang)\b/.test(query);
}

function productConstraints(message, filters) {
    const query = normalizeText(message);
    return Object.entries(filters).some(([key, value]) => !['limit', 'sort'].includes(key) && value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) ||
        /\b(?:meo|cho con|cho gia|cho cho|thu cung|hat|pate|thuc an|do choi|sua tam|cat ve sinh|vong co|day dat|dau ca|snack|ngan sach)\b/.test(query) ||
        /(?<!\p{L})chó(?!\p{L})/iu.test(message.normalize('NFC')) ||
        /\b(?:duoi|tren|tam|khoang|tu|toi da|it nhat)\s*(?:gia\s*)?\d/.test(budgetText(message));
}

function overviewQuestion(message, filters) {
    const query = normalizeText(message);
    if (productConstraints(message, filters)) return false;
    return /\b(?:ban|kinh doanh|cung cap)\s+(?:(?:nhung|cac)\s+)?(?:gi|(?:mat hang|loai hang|san pham)\s+(?:gi|nao))\b/.test(query) ||
        /\bco\s+(?:nhung|cac)\s+(?:(?:loai|nhom)\s+)?(?:hang|mat hang|san pham)\s+(?:gi|nao)\b/.test(query) ||
        (/\b(shop|cua hang|o day|ben minh|ben ban)\b/.test(query) && /\b(?:co(?: nhung)? gi|chuyen (?:ve|ban) gi|gioi thieu)\b/.test(query) && !CARE.test(query) && !/\b(?:cho|meo|thu cung)\b/.test(query));
}

function priceQuestion(message, query) {
    const priceQuery = query.replace(/\b(?:gia dinh|gia do|gia dung|(?:meo|cho|thu cung) con khong)\b/g, ' ')
        .replace(/\btam gia(?=\s*\d)/g, 'khoang').replace(/\s+/g, ' ').trim();
    if (!/\bgia\b/.test(priceQuery) && !STOCK_QUESTION.test(priceQuery)) return false;
    // Folding is useful for aliases but loses the meaning of già/giá. Keep
    // accented evidence and require a price expression in unaccented care.
    if (/(?:^|[^\p{L}])giá(?=$|[^\p{L}])/iu.test(message.normalize('NFC')) && /\bgia\b/.test(priceQuery)) return true;
    if (STOCK_QUESTION.test(priceQuery)) return true;
    if (/\b(?:gia\s+(?:bao nhieu|hien tai|hom nay|cua|san pham|pate|hat)|(?:hoi|xem|kiem tra|cho biet)\s+gia)\b/.test(priceQuery)) return true;
    if (/(?:^|[^\p{L}])già(?=$|[^\p{L}])/iu.test(message.normalize('NFC'))) return false;
    return !careQuestion(message);
}

function classifyIntent(message, filters = {}, history = []) {
    const query = normalizeText(message);
    if (categoryQuestion(query) && !productConstraints(message, filters)) return 'category_list';
    if (overviewQuestion(message, filters)) return 'catalog_overview';
    const substantive = query.replace(/\b(?:shop|cua hang|minh|ban|oi|nhi|nhe|a|nha|vay|the|roi)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!substantive || /^(?:(?:um|uh|u|o|hmm|hm|ha|ok|oke|duoc|gi|sao)\s*)+$/.test(substantive)) return 'clarification';
    if (/\b(so sanh|khac nhau|tot hon|giua hai|giua cac)\b/.test(query)) return 'compare';
    const merchandise = /\b(thuc an|thu can|hat|pate|pa te|snack|banh thuong|do choi|dau ca|sua tam|vong co|day dat|cat ve sinh)\b/.test(query);
    const care = careQuestion(message);
    if (/\b(dien thoai|smartphone|laptop|may tinh|tivi|ti vi|o to|xe may)\b/.test(query) && !merchandise && !care) return 'out_of_scope';
    if (priceQuestion(message, query)) return 'price_stock';
    if (history.length && followsProduct(message)) return 'follow_up';
    // A numeric amount disambiguates tầm/tam from tắm. Bathing advice without
    // an amount still follows the care path, including unaccented Vietnamese.
    if (/\b(?:duoi|toi da|khong qua|khoang|tam(?: gia)?|ngan sach|tu|tren|it nhat)\s*\d/.test(budgetText(message))) return 'product_search';
    const purchase = /\b(?:mua|tim|co ban|con ban|nen mua|nen chon)\b/.test(query);
    if (care && !purchase) return 'care';
    if (/\b(tu van|goi y|phu hop|nen mua|nen chon)\b/.test(query) && (PRODUCT.test(query) || !care)) return 'product_advice';
    if (GREETING.test(query) && !SHOPPING.test(query) && !PRODUCT.test(query)) return 'care';
    if (SHOPPING.test(query) || /^co\s+.+\s+khong$/.test(query)) return 'product_search';
    if (Object.keys(filters).some(key => !['limit', 'sort'].includes(key)) || PRODUCT.test(query) || /\b(re nhat|dat nhat)\b/.test(query)) return 'product_search';
    // Retain direct catalog-name lookup, while conversational fillers above
    // no longer become accidental product names.
    if (query.split(' ').length <= 6 && searchTerms(message).length) return 'product_search';
    return /\b(?:cho|meo|thu cung|boss)\b/.test(query) ? 'care' : 'clarification';
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
    const folded = budgetText(query);
    const value = '(\\d+(?:[.,]\\d+)*)(?:\\s*(trieu|nghin|ngan|tr|k|vnd|dong|d))?';
    const range = new RegExp('\\b(?:(tu|khoang|tam|ngan sach(?: khoang)?)\\s+)?' + value + '\\s*(?:den|toi|[-–—])\\s*' + value + '(?![a-z0-9])', 'i').exec(folded);
    const validRange = range && (range[1] || range[3] || range[5]) ? range : null;
    const upper = new RegExp('\\b(?:duoi|toi da|khong qua|khoang|tam(?: gia)?|ngan sach(?: (?:la|khoang|tam))?)\\s*' + value + '(?![a-z0-9])', 'i').exec(folded);
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
    const previous = [...history].reverse().find(entry => {
        const search = entry.search;
        return search && (search.query || search.keywords?.length || search.category || search.categoryId || search.productIds?.length ||
            search.minPrice !== undefined || search.maxPrice !== undefined || ['price_asc', 'price_desc'].includes(search.sort));
    })?.search;
    const assistant = [...history].reverse().find(entry => entry.role === 'assistant' && entry.product_ids?.length);
    const cheapest = /\b(re nhat|gia thap nhat|dat nhat|gia cao nhat)\b/.test(folded);
    const listedOnly = /\btrong (?:nhung|cac) (?:loai|san pham|lua chon) (?:do|nay)\b/.test(folded);
    const explicitComparison = /\b(so sanh|khac nhau|tot hon|giua hai|giua cac)\b/.test(folded) && comparisonSubjects(message);
    const followUp = !explicitComparison && (followsProduct(message) || /\b(so sanh|khac nhau|tot hon|giua hai|giua cac)\b/.test(folded));
    const budgetOnly = !inferred.query && (inferred.minPrice !== undefined || inferred.maxPrice !== undefined);
    let resolved = inferred;
    if (previous && (followUp || cheapest || budgetOnly)) {
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
        const context = { mode: selectedMode, intent, urgent, catalogStatus: 'not_requested', products: [], categories: [], totalMatches: 0, catalogLimited: false, contextLimited: false };
        const categoryIntent = ['catalog_overview', 'category_list'].includes(intent);
        const controlIntent = categoryIntent || ['clarification', 'out_of_scope'].includes(intent);
        if (context.mode === 'product' && !controlIntent) {
            context.search = resolvedSearch(message, filters, conversation);
            if (intent === 'compare' && !comparisonSubjects(message) && (context.search.productIds?.length || 0) < 2) {
                context.needsClarification = 'compare';
            }
            const query = normalizeText(message);
            const orphanReference = PRODUCT_REFERENCE.test(referenceText(message)) && followsProduct(message);
            const hasIds = context.search.productIds?.length > 0;
            if (!context.needsClarification && orphanReference && !hasIds && !comparisonSubjects(message)) context.needsClarification = 'product';
            context.requiresGeneration = intent === 'price_stock' && (careQuestion(message) || /\b(phu hop|thang tuoi|tuoi|benh|thuoc|thanh phan|cong dung)\b/.test(query));
        }
        return { conversation, intent, context };
    });
    const categoryIntent = ['catalog_overview', 'category_list'].includes(intent);
    if (context.mode === 'product' && categoryIntent) {
        try {
            const rows = await repository.listCategories();
            if (!Array.isArray(rows) || rows.some(row => !row || !Number.isInteger(row.category_id) || row.category_id < 1 || row.category_id > 2147483647 || typeof row.name !== 'string' || !row.name.trim())) throw new Error('Invalid category catalog');
            const unique = [...new Map(rows.map(row => [row.category_id, row])).values()];
            context.categories = unique.slice(0, 20).map(row => ({ category_id: row.category_id, name: row.name.trim().slice(0, 100) }));
            context.totalMatches = unique.length;
            context.catalogLimited = unique.length > context.categories.length;
            context.contextLimited = context.catalogLimited || rows.some(row => row.name.length > 100);
            context.catalogStatus = context.categories.length ? 'ok' : 'empty';
        } catch {
            context.catalogStatus = 'unavailable';
        }
    } else if (context.mode === 'product' && context.search && !context.needsClarification) {
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
                    ...(categoryIntent ? { categories: context.categories } : {}),
                    limited: context.catalogLimited || context.contextLimited,
                    missing_attributes: ['age_range', 'breed', 'health_suitability', 'promotion', 'brand_column'] }
            };
        }
        context.payload = payload();
        while (Buffer.byteLength(JSON.stringify(context.payload), 'utf8') > LIMITS.bytes && (conversation.length || context.products.length || context.categories.length)) {
            if (conversation.length) conversation.shift();
            else if (context.products.length) context.products.pop();
            else context.categories.pop();
            context.contextLimited = true;
            context.payload = payload();
        }
        if (!(categoryIntent ? context.categories.length : context.products.length) && context.catalogStatus === 'ok') {
            context.catalogStatus = 'empty';
            context.payload = payload();
        }
        if (Buffer.byteLength(JSON.stringify(context.payload), 'utf8') > LIMITS.bytes) invalid('Context exceeds byte limit');
        return context;
    });
}
module.exports = { buildContext, classifyIntent, inferSearch, LIMITS, isUrgent };
