'use strict';

const { createProductRepository, validateFilters } = require('./products');
const { getActiveContext } = require('./memory');
const { redactPersonal } = require('./grounding');
const ACTIVE = 'Đang bán';
const NAMES = ['list_categories', 'search_products', 'get_product_details', 'compare_products'];
const CRITERIA = ['price', 'stock', 'category', 'durability', 'ingredients', 'age_suitability', 'promotion', 'reviews', 'brand', 'material'];
const VERIFIED = ['price', 'stock', 'category'];
const FILTER_KEYS = ['query', 'keywords', 'categoryId', 'category', 'minPrice', 'maxPrice', 'limit', 'sort', 'species', 'productType'];
const PRODUCT_TYPES = ['food', 'kibble', 'wet_food', 'snack', 'toys', 'fish_oil'];
const error = code => Object.assign(new Error(code), { code });
const invalid = () => { throw error('INVALID_TOOL'); };
const unavailable = () => { throw error('CATALOG_UNAVAILABLE'); };
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const cents = value => BigInt(value.replace('.', ''));

function jsonArguments(value) {
    let nodes = 0;
    const visiting = new Set();
    function visit(item, depth) {
        if (++nodes > 2000 || depth > 8) invalid();
        if (item === null || ['string', 'boolean'].includes(typeof item)) return;
        if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return; }
        if (typeof item !== 'object' || visiting.has(item)) invalid();
        const array = Array.isArray(item);
        if (!(array ? Object.getPrototypeOf(item) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(item)))) invalid();
        visiting.add(item);
        const keys = Reflect.ownKeys(item);
        if (array && keys.length !== item.length + 1) invalid();
        for (const key of keys) {
            if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
            if (array && key === 'length') continue;
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
            visit(descriptor.value, depth + 1);
        }
        visiting.delete(item);
    }
    visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16000) invalid();
}

// Tool arguments are JSON data, not executable objects or SQL descriptions.
function object(value, required, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key) || !Object.hasOwn(descriptors[key], 'value')) ||
        required.some(key => !Object.hasOwn(value, key))) invalid();
}
function productIds(value, minimum = 1) {
    if (!Array.isArray(value) || value.length < minimum || value.length > 6 || new Set(value).size !== value.length || !value.every(id)) invalid();
}
function safeText(value, limit, nullable = false) {
    if (nullable && value == null) return null;
    if (typeof value !== 'string') unavailable();
    const clean = redactPersonal(value).replace(/<[^>]*>/g, ' ').replace(/[<>\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!nullable && !clean) unavailable();
    return clean.slice(0, limit);
}
function image(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > 500 || /[\s<>\u0000-\u001f]|(?:key|token|password)=/i.test(value)) return null;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null;
    } catch { return null; }
}
function product(row) {
    if (!row || !id(row.product_id) || !id(row.category_id) || !Number.isInteger(row.stock_quantity) || row.stock_quantity < 0 || row.stock_quantity > 2147483647 || row.status !== ACTIVE) unavailable();
    let price;
    try { price = validateFilters({ minPrice: row.price }).minPrice; } catch { unavailable(); }
    return { product_id: row.product_id, category_id: row.category_id,
        category_name: safeText(row.category_name, 100), name: safeText(row.name, 150),
        price, stock_quantity: row.stock_quantity, status: ACTIVE,
        available: row.stock_quantity > 0, image_url: image(row.image_url),
        description: safeText(row.description, 800, true), source: 'MySQL' };
}

function searchFilters(input, memory) {
    object(input, [], FILTER_KEYS);
    let filters;
    try { filters = validateFilters(input); } catch { invalid(); }
    if (!memory) return filters;
    const active = getActiveContext(memory);
    const saved = active.constraints.budget;
    if (saved?.source.kind === 'user') {
        const { min, max } = saved.value;
        if ((min !== null && filters.minPrice !== undefined && cents(filters.minPrice) < cents(min)) ||
            (max !== null && filters.maxPrice !== undefined && cents(filters.maxPrice) > cents(max))) invalid();
        if (min !== null && filters.minPrice === undefined) filters.minPrice = min;
        if (max !== null && filters.maxPrice === undefined) filters.maxPrice = max;
    }
    const species = active.pet?.species;
    if (species?.source.kind === 'user' && ['cat', 'dog'].includes(species.value)) {
        if (filters.species !== undefined && filters.species !== species.value) invalid();
        filters.species = species.value;
    }
    // Semantic query selection belongs to Gemini. This is only a typed default
    // when it omitted a query, not another natural-language intent classifier.
    const candidates = [active.needs.product_type, active.constraints.product_type].filter(Boolean);
    const type = candidates.find(item => item.source.kind === 'user') || candidates[0];
    if (type?.source.kind === 'user' && PRODUCT_TYPES.includes(type.value)) {
        if (filters.productType !== undefined && filters.productType !== type.value) invalid();
        filters.productType = type.value;
    }
    if (!filters.query && !filters.keywords.length && type?.source.kind === 'user' && typeof type.value === 'string') {
        const aliases = { kibble: 'hạt', dry_food: 'hạt', wet_food: 'pate', toys: 'đồ chơi', food: 'thức ăn' };
        filters.query = aliases[type.value] || type.value;
    }
    try { return validateFilters(filters); } catch { invalid(); }
}

function createProductTools({ repository = createProductRepository(), now = () => new Date().toISOString() } = {}) {
    function abort(signal) { if (signal?.aborted) throw error('TOOL_ABORTED'); }
    async function read(fn, signal) {
        abort(signal);
        try { const result = await fn(); abort(signal); return result; }
        catch (failure) {
            if (failure?.code === 'TOOL_ABORTED') throw failure;
            if (failure?.code === 'INVALID_SEARCH') invalid();
            unavailable();
        }
    }
    function stamp() {
        const observed = now();
        if (typeof observed !== 'string' || observed.length > 40 || !Number.isFinite(Date.parse(observed))) unavailable();
        return observed;
    }
    async function details(requested, signal) {
        const rows = await read(() => repository.getByIds(requested), signal);
        if (!Array.isArray(rows) || rows.length > 6) unavailable();
        const byId = new Map();
        for (const row of rows) {
            if (!row || !requested.includes(row.product_id) || byId.has(row.product_id)) unavailable();
            if (row.status !== ACTIVE) continue;
            byId.set(row.product_id, product(row));
        }
        return { products: requested.filter(value => byId.has(value)).map(value => byId.get(value)),
            missing_product_ids: requested.filter(value => !byId.has(value)) };
    }
    return { async execute(name, args, { memory, signal } = {}) {
        if (!NAMES.includes(name)) invalid();
        jsonArguments(args);
        abort(signal);
        if (name === 'list_categories') {
            object(args, []);
            const rows = await read(() => repository.listCategories(), signal);
            if (!Array.isArray(rows)) unavailable();
            const seen = new Set();
            const categories = rows.slice(0, 20).map(row => {
                if (!row || !id(row.category_id) || seen.has(row.category_id)) unavailable();
                seen.add(row.category_id);
                return { category_id: row.category_id, name: safeText(row.name, 100) };
            });
            return { status: categories.length ? 'ok' : 'empty', observed_at: stamp(), categories, limited: rows.length > 20 };
        }
        if (name === 'search_products') {
            object(args, ['filters'], ['include_out_of_stock']);
            if (Object.hasOwn(args, 'include_out_of_stock') && typeof args.include_out_of_stock !== 'boolean') invalid();
            const filters = searchFilters(args.filters, memory);
            const result = await read(() => repository.search(filters, { includeOutOfStock: args.include_out_of_stock === true }), signal);
            if (!result || !Array.isArray(result.products) || !Number.isInteger(result.totalMatches) || result.totalMatches < 0) unavailable();
            const products = result.products.slice(0, filters.limit).map(product);
            if (new Set(products.map(row => row.product_id)).size !== products.length) unavailable();
            if (products.some(row => (!args.include_out_of_stock && !row.available) ||
                (filters.minPrice !== undefined && cents(row.price) < cents(filters.minPrice)) ||
                (filters.maxPrice !== undefined && cents(row.price) > cents(filters.maxPrice)))) unavailable();
            return { status: products.length ? 'ok' : 'empty', observed_at: stamp(), products,
                search: filters, total_matches: result.totalMatches,
                limited: Boolean(result.catalogLimited) || result.totalMatches > products.length };
        }
        object(args, ['product_ids', ...(name === 'compare_products' ? ['criteria'] : [])]);
        productIds(args.product_ids, name === 'compare_products' ? 2 : 1);
        if (name === 'compare_products' && (!Array.isArray(args.criteria) || !args.criteria.length || args.criteria.length > CRITERIA.length ||
            new Set(args.criteria).size !== args.criteria.length || args.criteria.some(value => !CRITERIA.includes(value)))) invalid();
        const result = await details(args.product_ids, signal);
        if (name === 'get_product_details') return { status: result.products.length ? 'ok' : 'empty', observed_at: stamp(), ...result };
        const criteria = args.criteria.filter(value => VERIFIED.includes(value));
        const comparison = { criteria, not_verified: args.criteria.filter(value => !VERIFIED.includes(value)),
            rows: result.products.map(row => ({ product_id: row.product_id,
                ...(criteria.includes('price') ? { price: row.price } : {}),
                ...(criteria.includes('stock') ? { stock_quantity: row.stock_quantity, available: row.available } : {}),
                ...(criteria.includes('category') ? { category_id: row.category_id, category_name: row.category_name } : {}) })) };
        if (criteria.includes('price') && result.products.length >= 2) {
            const minimum = result.products.reduce((best, row) => cents(row.price) < best ? cents(row.price) : best, cents(result.products[0].price));
            comparison.cheapest_product_ids = result.products.filter(row => cents(row.price) === minimum).map(row => row.product_id);
        }
        return { status: result.products.length ? 'ok' : 'empty', observed_at: stamp(), ...result, comparison };
    } };
}

module.exports = { createProductTools };
