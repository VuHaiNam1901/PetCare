'use strict';

const { normalizeText } = require('./products');
const entries = require('./website-knowledge-data');
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
freeze(entries);
const byId = new Map(entries.map(entry => [entry.id, entry]));
const TOPICS = Object.freeze(entries.map(entry => entry.id));
const invalid = () => { throw Object.assign(new Error('INVALID_TOOL'), { code: 'INVALID_TOOL' }); };
const reject = () => { throw new Error('Unverified website instruction'); };
const numbers = text => [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map(match => match[0].replace(/[.,]/g, ''));

// Gemini chooses semantic topic IDs using the current question + Memory Core.
// No keyword router, SQL, user state, filesystem access or external retrieval.
function getWebsiteGuides(args) {
    if (!args || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
        Reflect.ownKeys(args).length !== 1 || !Object.hasOwn(args, 'topics') ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(args, 'topics'), 'value')) invalid();
    const topics = args.topics;
    if (!Array.isArray(topics) || !topics.length || topics.length > 2 || new Set(topics).size !== topics.length ||
        topics.some(id => typeof id !== 'string' || !byId.has(id))) invalid();
    const guides = topics.map(id => {
        const { sources, ...guide } = byId.get(id);
        return JSON.parse(JSON.stringify(guide));
    });
    return { status: 'ok', source: 'reviewed_website_source', scope: 'static_usage_only',
        current_account_data: false, can_execute_actions: false, guides };
}

// Only a successfully retrieved guide in this request authorizes website
// prose. These guards bound concrete routes, labels and numeric rules; Gemini
// must still paraphrase the conditions faithfully, never infer account state.
function validateWebsiteProse(text, guides, pageContext) {
    if (!Array.isArray(guides) || !guides.length || guides.some(guide => !byId.has(guide.id))) reject();
    const verified = guides.map(guide => byId.get(guide.id));
    const { isResolvedPageContext, validatePageProse } = require('./page-context');
    const current = isResolvedPageContext(pageContext) ? pageContext : null;
    const currentLabels = current ? [current.page.name, ...current.ui.actions.map(action => action.label),
        ...(current.order?.verification === 'verified' ? [current.order.status] : [])] : [];
    validatePageProse(text, current);
    const allowedNumbers = new Set(numbers(JSON.stringify(verified.map(({ sources, ...guide }) => guide))));
    // Only bounded, structural observations may add numbers to website prose.
    // Never whitelist numeric substrings from raw URLs, input text or PII.
    if (current) for (const value of [current.cart.item_count, current.cart.selected_count, current.state.quantity]) {
        if (Number.isSafeInteger(value)) allowedNumbers.add(String(value));
    }
    if (numbers(text).some(number => !allowedNumbers.has(number))) reject();
    const routes = new Set(verified.flatMap(guide => guide.routes));
    if (current) routes.add(current.page.route);
    if (/\[[^\]\n]+\]\([^\)\n]+\)/.test(text)) reject();
    for (const match of text.matchAll(/\/(?:[a-z]|#)[a-z0-9_:/#?=&.-]*/gi)) {
        if (!routes.has(match[0].replace(/[.,;:]+$/, ''))) reject();
    }
    const labels = new Set(verified.flatMap(guide => [guide.name, ...guide.labels]).map(normalizeText));
    for (const label of currentLabels) labels.add(normalizeText(label));
    for (const match of text.matchAll(/(?:nút|mục|trang|ô|phần|nhấn|bấm|chọn|mở)\s+["“]([^"”\n]{1,100})["”]/giu)) {
        if (!labels.has(normalizeText(match[1]))) reject();
    }
    const folded = normalizeText(text);
    if (/[$€%]/.test(text) || /(?<!danh )\bgia\b.{0,30}\d|\b(?:ton kho|con hang|con lai|hien co)\b.{0,30}\d/.test(folded)) reject();
    for (const match of text.matchAll(/\d+(?:[.,]\d+)*\s*(?:₫|đ|đồng|vnd)(?![\p{L}])/giu)) {
        if (!verified.some(guide => guide.id === 'voucher') || numbers(match[0])[0] !== '0') reject();
    }
    if (/\b(?:toi|minh|tro ly)(?: da| dang| se)\s+(?:huy|dat|thanh toan|hoan tien|ap dung|chuyen trang|mo trang|gui yeu cau)\b/.test(folded)) reject();
    for (const raw of text.split(/[.!?;\n]+|\b(?:nhưng|tuy nhiên)\b/iu)) {
        const clause = normalizeText(raw);
        const claim = /\bdon(?: hang)? (?:cua ban|so \d+|\d+)\b.{0,65}\b(?:da|dang|du dieu kien|con han|duoc huy|khong duoc huy)\b/.exec(clause);
        if (claim && current?.order?.verification !== 'verified' && !/\b(?:neu|khi|chua the xac nhan|khong the xac nhan|can kiem tra)\b/.test(clause.slice(0, claim.index))) reject();
    }
    if (/\b(?:ben hon|ben nhat|do ben cao|chat luong cao)\b/.test(folded)) reject();
    if (/\bvnpay\b/.test(folded) && (!/\b(?:chua|khong)\b/.test(folded) ||
        /\b(?:nhan|bam|chon|truy cap|quet ma|nhap the|chuyen sang|chuyen den)\b.{0,45}\bvnpay\b/.test(folded))) reject();
    // Mask only verified UI terms before the existing proper-name guard. No
    // product name or data from another request becomes trusted through KB.
    let prose = text;
    for (const label of [...verified.flatMap(guide => guide.labels), ...currentLabels].sort((a, b) => b.length - a.length)) {
        const pattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        prose = prose.replace(new RegExp(pattern, 'giu'), 'chức năng');
    }
    return prose;
}

module.exports = { TOPICS, getWebsiteGuides, validateWebsiteProse };
