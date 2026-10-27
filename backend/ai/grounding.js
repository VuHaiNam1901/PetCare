const { normalizeText } = require('./products');

// These are deliberately fixed labels: diagnostics must never contain model
// output, catalog text, credentials, or the original exception message.
const REJECTION_CODES = Object.freeze([
    'Invalid model response', 'Unexpected model fields', 'Ungrounded products',
    'Invalid text', 'Sensitive output', 'Invalid warnings', 'Generated commercial facts',
    'Generated product name', 'Generated inventory', 'Unverified proper name in prose',
    'Product name belongs in a card', 'Diagnosis or medication instruction',
    'Unverified suitability or medical advice'
]);
const rejectionCodes = new Set(REJECTION_CODES);
const rejectionCode = error => rejectionCodes.has(error?.message) ? error.message : 'Invalid model response';
const reject = message => { throw new Error(message); };
const fold = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER = '\\d+(?:[.,]\\d+)*';
const UNIT = '(?:trieu|nghin|ngan|tr|k|vnd|dong|d|₫)';
const MONEY = new RegExp(`(?<![\\p{L}\\p{N}])(${NUMBER})\\s*(${UNIT})(?![\\p{L}\\p{N}])`, 'gu');

function redactPersonal(value) {
    return String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email đã ẩn]')
        .replace(/(?:\+?84|0)(?:[ .-]?\d){8,10}\b/g, '[điện thoại đã ẩn]')
        .replace(/AIza[\w-]+|Bearer\s+[^\s]+|eyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[bí mật đã ẩn]')
        .replace(/((?:api[_ -]?key|access[_ -]?token|password|mật khẩu)\s*[:=]\s*)[^\s,;]+/gi, '$1[bí mật đã ẩn]')
        .replace(/(?:địa chỉ|dia chi)\s*[:=]\s*[^\n;]+/gi, '[địa chỉ đã ẩn]');
}

function safeText(value, max, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\p{Cf}/u.test(value)) reject('Invalid text');
    const text = value.normalize('NFC').trim();
    if (redactPersonal(text) !== text || /(?:system.?prompt|GEMINI_API_KEY|JWT_SECRET|DATABASE_PASSWORD|```|https?:\/\/|www\.)/i.test(text)) reject('Sensitive output');
    return text;
}

// Currency comparisons use integer cents, including values above the safe
// integer range after multiplication. No float rounding can verify a price.
function cents(value, unit = '') {
    let raw = String(value ?? '').trim();
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, '');
    else raw = raw.replace(',', '.');
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null;
    const [whole, fraction = ''] = raw.split('.');
    const multiplier = /^(?:tr|trieu)$/.test(unit) ? 1000000n : /^(?:k|nghin|ngan)$/.test(unit) ? 1000n : 1n;
    return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * multiplier;
}

function selectedProducts(plan, context) {
    const products = Array.isArray(context.products) ? context.products : [];
    const allowed = new Map(products.filter(product => product.status === 'Đang bán' && (product.stock_quantity > 0 || context.intent === 'price_stock')).map(product => [product.product_id, product]));
    if (!Array.isArray(plan.product_ids) || plan.product_ids.length > 3 || new Set(plan.product_ids).size !== plan.product_ids.length || plan.product_ids.some(id => !Number.isInteger(id) || !allowed.has(id)) || (context.mode !== 'product' && plan.product_ids.length)) reject('Ungrounded products');
    const selected = plan.product_ids.map(id => allowed.get(id));
    for (const product of selected) {
        const price = cents(product.price);
        for (const [key, less] of [['minPrice', true], ['maxPrice', false]]) {
            if (context.search?.[key] === undefined) continue;
            const bound = cents(context.search[key]);
            if (price === null || bound === null || (less ? price < bound : price > bound)) reject('Ungrounded products');
        }
    }
    return selected;
}

function removeVerifiedBudget(text, context) {
    if (!text || context.mode !== 'product' || !context.search) return text;
    // Work on a folded copy to preserve positions of NFC Vietnamese text.
    // Only the budget span is erased; a separate invented product price in
    // the same sentence is still visible to the commercial fact checks.
    const source = fold(text);
    const patterns = [
        new RegExp(`\\b(?:(?:tu|khoang|tam|ngan sach(?: khoang)?)\\s+)?(${NUMBER})\\s*(${UNIT})?\\s*(?:den|toi|[-–—])\\s*(${NUMBER})\\s*(${UNIT})?(?![\\p{L}\\p{N}])`, 'gu'),
        new RegExp(`\\b(duoi|toi da|khong qua|tren|it nhat)\\s*(${NUMBER})\\s*(${UNIT})?(?![\\p{L}\\p{N}])`, 'gu'),
        new RegExp(`\\bngan sach(?:\\s+(?:la|khoang|tam))?\\s*(${NUMBER})\\s*(${UNIT})?(?![\\p{L}\\p{N}])`, 'gu')
    ];
    const spans = [];
    const matches = (key, value) => value !== null && context.search[key] !== undefined && value === cents(context.search[key]);
    patterns.forEach((pattern, type) => {
        for (const match of source.matchAll(pattern)) {
            if (spans.some(span => match.index < span.end && match.index + match[0].length > span.start)) continue;
            let verified;
            if (type === 0) verified = matches('minPrice', cents(match[1], match[2] || match[4])) && matches('maxPrice', cents(match[3], match[4] || match[2]));
            else if (type === 1) verified = matches(/^(?:tren|it nhat)$/.test(match[1]) ? 'minPrice' : 'maxPrice', cents(match[2], match[3]));
            else verified = matches('maxPrice', cents(match[1], match[2]));
            // "giá dưới 200k" is a product price claim, not a budget echo.
            const prefix = normalizeText(text.slice(Math.max(0, match.index - 35), match.index));
            if (/\bgia(?: la| chi| hien tai| hien tai la)?$/.test(prefix)) verified = false;
            if (verified) spans.push({ start: match.index, end: match.index + match[0].length });
        }
    });
    for (const span of spans.sort((a, b) => b.start - a.start)) text = text.slice(0, span.start) + 'trong ngân sách bạn đã nêu' + text.slice(span.end);
    return text.replace(/\b(?:trong|với|theo)\s+trong ngân sách bạn đã nêu/giu, match => `${match[0] === match[0].toUpperCase() ? 'Trong' : 'trong'} ngân sách bạn đã nêu`);
}

function namePattern(name) {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, 'giu');
}

function replaceVerifiedCardFacts(text, selected) {
    if (!text || !selected.length) return text;
    // A price is verifiable only when its clause names exactly one selected
    // product. An amount merely equalling some catalog price proves nothing.
    return text.split(/([!?;\n]|\.\s+)/u).map((clause, part) => {
        if (part % 2) return clause;
        const named = selected.filter(product => String(product.name).length >= 6 && namePattern(String(product.name)).test(clause));
        if (named.length === 1) {
            const matches = [...fold(clause).matchAll(MONEY)];
            for (const match of matches.reverse()) {
                if (cents(match[1], match[2]) !== cents(named[0].price)) reject('Generated commercial facts');
                clause = clause.slice(0, match.index) + 'được ghi trong thẻ sản phẩm' + clause.slice(match.index + match[0].length);
            }
        }
        for (const product of [...selected].sort((a, b) => String(b.name).length - String(a.name).length)) {
            if (String(product.name).length < 6) continue;
            const index = selected.indexOf(product);
            clause = clause.replace(namePattern(String(product.name)), (_, prefix) => `${prefix}lựa chọn thứ ${['nhất', 'hai', 'ba'][index]} trong thẻ sản phẩm`);
        }
        return clause;
    }).join('');
}

// Uppercase alone is not evidence of a brand: ordinary unaccented Vietnamese
// such as "Ban Nen" was previously rejected. Check naming contexts and only
// suspicious proper-name shapes, after confirmed catalog names are replaced.
const commonWords = new Set(('ban nen minh hay cho meo be thu cung lua chon cac nhung loai thuc an do choi bat nuoc sach giu ve sinh nha cua san pham duoi tren neu khi can khong chua co du thong tin du lieu de xac nhan khang dinh phu hop tuoi thang chu y cham soc dinh duong hanh vi tap luyen thuong ngay mot hai ba ben nay do la thi va voi dung su noi o ngon nhe tot them mot vai nguyen lieu huong dan bao bi nhan dang duoc khoang ngan sach trong xem nho lon theo doi chia nho bua tu tu tien nhu cau uu tien tim hieu cach doi don sau moi giup lam quen hoat dong deu dan luon tao an toan han che bao dam').split(' '));
const genericAfterNaming = new Set(('cac nhung mot vai lua chon loai thuc an do choi bat nuoc sua cat vong day khay long chen cho meo be thu cung cach nhe theo dung san pham khau phan qua trinh nhan bao bi dung cu noi ngu cho o ve sinh cham soc tap luyen bac si thu y thuoc khan mem gel lich thoi phuong the that nao duoi tren').split(' '));

// Generic size/material terms are not brand names, including uppercase INOX.
for (const word of ['size', 'inox']) { commonWords.add(word); genericAfterNaming.add(word); }

function assertNoInventedName(text, context) {
    const source = fold(text);
    for (const match of source.matchAll(/(?=(\b(?:san pham|nhan hieu|thuong hieu|brand|mua|chon|dung|de xuat|goi y|thuc an|pate|sua tam|cat ve sinh|minh co|shop co|cua hang co|co ban)\s+(?:moi\s+)?([a-z][a-z0-9_-]{2,})))/g)) {
        const offset = match.index + match[1].lastIndexOf(match[2]);
        const originalWord = text.slice(offset, offset + match[2].length);
        if (!genericAfterNaming.has(match[2]) && !commonWords.has(match[2]) && !/[^\x00-\x7F]/.test(originalWord)) reject('Generated product name');
    }
    const prose = text.replace(/PetCare(?:Shop)?/g, 'trợ lý');
    for (const match of prose.matchAll(/\b[A-Z][a-z]{2,}\s+[A-Z][A-Za-z0-9+_-]{2,}\b|\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b|\b[A-Z]{3,}[A-Z0-9+_-]*\b/g)) {
        if (normalizeText(match[0]).split(' ').some(word => !commonWords.has(word))) reject('Unverified proper name in prose');
    }
    // Also cover lowercase names used as a sentence subject without "buy".
    const subject = /(?:^|[.!?]\s*)([\p{L}][\p{L}\d_-]{2,})(?:\s+([\p{L}][\p{L}\d_-]{2,}))?\s+(?:rat tot|chat luong cao|tot cho|giup dieu tri)\b/giu;
    for (const match of fold(text).matchAll(subject)) if (!commonWords.has(match[1])) reject('Generated product name');
    for (const product of context.products || []) {
        if (String(product.name).length >= 6 && namePattern(String(product.name)).test(text)) reject('Product name belongs in a card');
    }
}

function negatedClaim(prefix) {
    // A new affirmative verb starts its own scope. Otherwise "không thể xác
    // nhận giá và khẳng định ... an toàn" inherited the earlier disclaimer.
    prefix = prefix.split(/\b(?:va|nhung|tuy nhien|tuy vay)\s+(?=(?:khang dinh|xac nhan|dam bao|chac chan|ket luan|cam ket)\b)/).at(-1);
    return /\b(?:khong|chua|chang)(?:\s+(?:the|he|nen|duoc))*\s*$/.test(prefix)
        || /\b(?:khong(?: the)?|chua(?: the)?)\s+(?:khang dinh|xac nhan|dam bao|ket luan|cho rang|chac|chan doan|ke don)\b[^,;.!?]{0,110}$/.test(prefix)
        || /\b(?:chua|khong(?: co)?)\s+du\s+(?:du lieu|thong tin|co so)\b[^,;.!?]{0,110}$/.test(prefix)
        || /\b(?:khong|chua)\s+co\s+(?:thong tin|du lieu|co so)(?: cu the)?\s+(?:de\s+)?(?:xac nhan|khang dinh|ket luan|biet|danh gia)\b[^,;.!?]{0,110}$/.test(prefix)
        || /\b(?:du lieu|thong tin)(?: hien(?: tai)?(?: co)?)?\s+(?:chua|khong)\s+(?:cung cap(?: thong tin)?|cho biet|neu ro)\s+lieu\b[^,;.!?]{0,110}$/.test(prefix)
        // Checking a label to ensure suitability expresses a verification
        // goal. It does not assert that the product already meets that goal.
        || /\b(?:ban\s+)?(?:(?:nen|hay|can)\s+)?kiem tra\s+(?:nhan|huong dan|bao bi)\b[^,;.!?]{0,45}\bde\s+(?:(?:dam bao|xac nhan|biet|kiem tra)\b[^,;.!?]{0,100})?$/.test(prefix)
        || /\bcan\s+(?:kiem tra|xac minh|hoi)\b[^,;.!?]{0,70}$/.test(prefix)
        || /\bkhong(?: nen)? tu\s*$/.test(prefix);
}

function assertNoConcreteMedication(text) {
    const folded = normalizeText(text);
    const concreteDrugOrDose = /\b(paracetamol|acetaminophen|ibuprofen|amoxicillin|prednisolone|ivermectin|metronidazole)\b/.test(folded)
        || /\d\s*(?:mg|mcg|ml\s*\/\s*kg)\b/i.test(text)
        || (/\d\s*ml\b/i.test(text) && /\b(thuoc|lieu)\b/.test(folded))
        || (/\d\s*ml\b/i.test(text) && /\b(uong|dung|moi ngay)\b/.test(folded) && !/\bnuoc\b/.test(folded));
    if (concreteDrugOrDose) reject('Diagnosis or medication instruction');
}

function validateProse(text, context) {
    const folded = normalizeText(text);
    assertNoConcreteMedication(text);
    if (/[₫$€]/.test(text) || [...fold(text).matchAll(MONEY)].length || /\b(?:gia|ton kho|so luong|con lai)\b.{0,35}\d/.test(folded)) reject('Generated commercial facts');
    for (const match of fold(text).matchAll(/\b(?:khuyen mai|giam gia|mien phi|con hang|het hang|san co)\b/g)) {
        if (!negatedClaim(fold(text).slice(0, match.index))) reject('Generated commercial facts');
    }
    if (/\bcon\s+\d+\s+(?:san pham|goi|hop|chai|tui)|\b\d+\s+(?:san pham|goi|hop|chai|tui)\s+(?:trong kho|san co)\b/.test(folded)) reject('Generated inventory');
    assertNoInventedName(text, context);
    for (const clause of text.split(/[.!?;,\n]+|\b(?:nhưng|tuy nhiên|tuy vậy|nhung|tuy nhien|tuy vay)\b/iu)) {
        const s = normalizeText(clause);
        // Concrete medications and dosages remain hard failures even inside a
        // disclaimer. A cautious opener cannot launder a later instruction.
        const diagnosis = /\b(?:meo|cho|be|thu cung)(?: cua ban)?(?: dang| da)? (?:bi|mac) (?:benh|viem|suy|nhiem|parvo|carre|tieu duong)\b/g;
        for (const match of s.matchAll(diagnosis)) if (!/^neu\b/.test(s) && !negatedClaim(s.slice(0, match.index))) reject('Diagnosis or medication instruction');
        const claims = [
            /\b(?:chac chan|dam bao|hoan toan an toan|dieu tri duoc)\b/g,
            /\b(?:tri benh|chua benh|dieu tri|tang mien dich|bo than|ngan ngua benh|giam can hieu qua|chua viem|tri viem)\b/g,
            /\b(?:ke don|lieu dung|chan doan la)\b/g
        ];
        if (/\bthuoc\b/.test(s)) claims.push(/\bcho uong\b/g);
        if (/\b(?:thang|tuoi|giong|benh|meo con|cho con|than|tieu duong|poodle|corgi|husky|pug|alaska|ba tu|anh long ngan)\b/.test(s)) claims.push(/\b(?:phu hop|danh cho|dung duoc|an toan|co the (?:dung|an|su dung))\b/g);
        if (/\b(?:san pham|lua chon|loai nay|loai do|hat nay|hat do|pate nay|pate do|pa te nay|pa te do|thuc an nay|thuc an do|thanh phan)\b/.test(s)) {
            // Keep accents for chứa/chưa: folding both to "chua" used to
            // mistake a lack of ingredient data for an ingredient assertion.
            const ingredients = /(?<![\p{L}\p{N}])(?:chứa|chua|thành phần|thanh phan|giàu|giau|bổ sung|bo sung)(?![\p{L}\p{N}]).{0,70}(?:protein|omega|vitamin|canxi|chất|chat)/giu;
            for (const match of clause.matchAll(ingredients)) if (!negatedClaim(normalizeText(clause.slice(0, match.index)))) reject('Unverified suitability or medical advice');
            claims.push(/\b(?:ho tro tieu hoa|ho tro mien dich|ho tro xuong khop|ho tro suc khoe|tang cuong suc khoe|tang cuong mien dich|giam rung long|lam dep long|sang long|tot cho than|tot cho gan|giam nguy co|ngan ngua)\b/g);
        }
        if (clause.toLowerCase().includes('chữa khỏi')) claims.push(/\bchua khoi\b/g);
        for (const pattern of claims) for (const match of s.matchAll(pattern)) if (!negatedClaim(s.slice(0, match.index))) reject('Unverified suitability or medical advice');
    }
}

function validatePlan(response, context) {
    if (response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason !== 'STOP' || typeof response.text !== 'string' || response.text.length > 7000) reject('Invalid model response');
    let plan;
    try { plan = JSON.parse(response.text); } catch { reject('Invalid model response'); }
    const keys = ['advice', 'product_ids', 'follow_up', 'warnings'];
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== 4 || Object.keys(plan).some(key => !keys.includes(key))) reject('Unexpected model fields');
    const selected = selectedProducts(plan, context);
    const prepare = (value, max, nullable = false) => {
        const safe = safeText(value, max, nullable);
        if (safe === null) return null;
        assertNoConcreteMedication(safe);
        const text = replaceVerifiedCardFacts(removeVerifiedBudget(safe, context), selected);
        validateProse(text, context);
        return text;
    };
    plan.advice = prepare(plan.advice, 1800);
    plan.follow_up = prepare(plan.follow_up, 250, true);
    if (!Array.isArray(plan.warnings) || plan.warnings.length > 2) reject('Invalid warnings');
    plan.warnings = plan.warnings.map(warning => prepare(warning, 300));
    return plan;
}

module.exports = { validatePlan, redactPersonal, rejectionCode, REJECTION_CODES };
