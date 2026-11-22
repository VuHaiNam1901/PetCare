const { measure } = require('./metrics');
const PAGE_SIZE = 64;
const DESCRIPTION_LIMIT = 1200;
const ACTIVE_STATUS = 'Đang bán';
const PET_SPECIES = Object.freeze(['cat', 'dog', 'bird', 'fish', 'hamster', 'rabbit']);
const PET_TYPES_SQL = `COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT(
    'pet_type_id', pt.pet_type_id, 'slug', pt.slug, 'name', pt.name))
    FROM product_pet_types ppt JOIN pet_types pt ON pt.pet_type_id = ppt.pet_type_id
    WHERE ppt.product_id = p.product_id), JSON_ARRAY()) AS pet_types`;
function classified(row) {
    const petTypes = typeof row.pet_types === 'string' ? JSON.parse(row.pet_types) : row.pet_types;
    if (!Array.isArray(petTypes)) throw new Error('Invalid catalog classification');
    return { ...row, pet_types: petTypes };
}
function checkSignal(signal) {
    if (signal?.aborted) throw Object.assign(new Error('Product query aborted'), { code: 'TOOL_ABORTED' });
}
function defaultDatabase() {
    require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
    return require('../config/db');
}
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_SEARCH' }); };
const normalizeText = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const STOP_WORDS = new Set('toi minh ban hay giup tim kiem mua san pham cua hang petcare shop oi nhi nha tu van goi y muon can loai nao gi mot vai cac nhung voi va la co biet ve duoc phu hop nhat khong nhe xem danh sach gia bao nhieu tien ngan sach khoang tam duoi tren toi da it qua re dat hon tot ngon bo de su dung ma nay do ay the danh thang tuoi kg g trieu nghin ngan k vnd dong'.split(' '));
// Deliberately small alias groups avoid arbitrary fuzzy matches.
const CONCEPTS = [
    ['dau ca', 'fish oil', 'omega 3', 'omega3'],
    ['do choi', 'dochoi', 'toy', 'toys', 'bong', 'can cau'],
    ['pate', 'pa te', 'thuc an uot', 'wet food'],
    ['snack', 'banh thuong', 'do an vat', 'treat', 'treats'],
    ['hat', 'thuc an kho', 'dry food', 'kibble'],
    ['thuc an', 'thu can', 'thucan', 'do an', 'food'],
    ['cat ve sinh', 'nha ve sinh', 'khay ve sinh', 'xeng ve sinh', 'litter'],
    ['meo', 'meoo', 'cat', 'cats'],
    ['cho', 'dog', 'dogs'],
    ['chim', 'bird', 'birds'],
    ['ca canh', 'fish'],
    ['hamster', 'chuot hamster', 'chuot'],
    ['tho', 'rabbit', 'rabbits']
];
const FOOD_TYPES = new Set(['thuc an', 'hat', 'pate', 'snack']);
const PRODUCT_TYPES = new Set([...FOOD_TYPES, 'dau ca', 'do choi']);
const TYPED_PRODUCT_TYPES = Object.freeze({ food: 'thuc an', kibble: 'hat', wet_food: 'pate', snack: 'snack', toys: 'do choi', fish_oil: 'dau ca' });
const NON_FOOD_CATEGORY = /\b(phu kien|ve sinh|do choi|long chuong|van chuyen|quan ao)\b/;
const NON_FOOD_NAME = /\b(do choi|sua tam|dau goi|vong co|day dat|long van chuyen|cat ve sinh|nha ve sinh|khay ve sinh|luoc chai)\b/;
const FOOD_CONTAINER = /\b(?:(?:hop|thung|tui|binh|khay|lo|bao|bat|chen|dia)\s+(?:dung|chua|bao quan)|(?:bat|chen|khay|dia)\s+(?:an|thuc an)|may\s+(?:tu dong\s+)?cho an)\b/;

function text(value, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) invalid('Invalid search text');
    return value.trim();
}
function decimal(value) {
    if (!['string', 'number'].includes(typeof value)) invalid('Invalid price bound');
    const raw = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(raw)) invalid('Price must be 0..9999999999.99 with at most two decimal places');
    const [whole, fraction = ''] = raw.split('.');
    return whole + '.' + fraction.padEnd(2, '0');
}
const toCents = value => BigInt(decimal(value).replace('.', ''));

function validateFilters(input = {}) {
    const allowed = ['query', 'keywords', 'categoryId', 'category', 'minPrice', 'maxPrice', 'limit', 'sort', 'productIds', 'species', 'productType'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) invalid('Unsupported search filters');
    const filters = { limit: input.limit ?? 6, keywords: [] };
    if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 6) invalid('Search limit must be 1..6');
    if (input.query !== undefined && input.query !== '') filters.query = text(input.query, 300);
    if (input.category !== undefined) filters.category = text(input.category, 100);
    if (input.categoryId !== undefined) {
        if (!Number.isInteger(input.categoryId) || input.categoryId < 1 || input.categoryId > 2147483647) invalid('Invalid category ID');
        filters.categoryId = input.categoryId;
    }
    if (input.species !== undefined) {
        if (!PET_SPECIES.includes(input.species)) invalid('Invalid product species');
        filters.species = input.species;
    }
    if (input.productType !== undefined) {
        if (typeof input.productType !== 'string' || !Object.hasOwn(TYPED_PRODUCT_TYPES, input.productType)) invalid('Invalid product type');
        filters.productType = input.productType;
    }
    if (input.keywords !== undefined) {
        if (!Array.isArray(input.keywords) || input.keywords.length > 8) invalid('At most eight search keywords are accepted');
        filters.keywords = input.keywords.map(value => text(value, 80));
    }
    if (input.sort !== undefined) {
        if (!['relevance', 'price_asc', 'price_desc'].includes(input.sort)) invalid('Invalid search sort');
        filters.sort = input.sort;
    }
    if (input.productIds !== undefined) {
        if (!Array.isArray(input.productIds) || input.productIds.length > 24 || input.productIds.some(id => !Number.isInteger(id) || id < 1 || id > 2147483647)) invalid('Invalid product IDs');
        filters.productIds = [...new Set(input.productIds)];
    }
    for (const key of ['minPrice', 'maxPrice']) if (input[key] !== undefined) filters[key] = decimal(input[key]);
    if (filters.minPrice !== undefined && filters.maxPrice !== undefined && toCents(filters.minPrice) > toCents(filters.maxPrice)) invalid('Minimum price exceeds maximum price');
    return filters;
}

const contains = (haystack, needle) => (` ${haystack} `).includes(` ${needle} `);
function searchTerms(query = '') {
    let folded = normalizeText(query);
    // 'cho mèo / cho thỏ / ...' uses cho as a preposition; 'chó' itself remains searchable.
    const hasNonDogSpecies = /\b(?:meo|chim|hamster|chuot|tho)\b/.test(folded)
        || /(?:^|[^\p{L}])(?:cá|cá cảnh)(?=$|[^\p{L}])/iu.test(String(query))
        || /\bca canh\b/.test(folded);
    const skipPrepositionCho = hasNonDogSpecies && !/chó/i.test(query) && !/\bcho cho\b/.test(folded);
    const terms = [];
    // Consume long phrases first, so "thức ăn ướt" means pâté rather than food.
    const aliases = CONCEPTS.flatMap(group => group.map(alias => ({ alias, canonical: group[0] }))).sort((a, b) => b.alias.length - a.alias.length);
    for (const { alias, canonical } of aliases) {
        if (canonical === 'cho' && skipPrepositionCho) continue;
        if (contains(folded, alias)) {
            terms.push(canonical);
            folded = (` ${folded} `).split(` ${alias} `).join(' ').trim();
        }
    }
    terms.push(...folded.split(' ').filter(word => word && !STOP_WORDS.has(word) && !/^\d+$/.test(word) && !(skipPrepositionCho && word === 'cho')));
    return [...new Set(terms)];
}

function species(value) {
    const raw = String(value ?? '').normalize('NFC').toLowerCase();
    const folded = normalizeText(raw);
    // An unaccented "cho" alone is often the Vietnamese preposition "for".
    // Accented "cá" avoids colliding with folded "ca" ("cả").
    return {
        dog: /(?:^|[^\p{L}])(?:chó|dog|dogs)(?=$|[^\p{L}])/iu.test(raw) || /\bcho cho\b/.test(folded),
        cat: /(?:^|[^\p{L}])(?:mèo|meo|cat|cats)(?=$|[^\p{L}])/iu.test(raw),
        bird: /(?:^|[^\p{L}])(?:chim|bird|birds)(?=$|[^\p{L}])/iu.test(raw),
        fish: /(?:^|[^\p{L}])(?:cá|cá cảnh|fish)(?=$|[^\p{L}])/iu.test(raw) || /\bca canh\b/.test(folded),
        hamster: /(?:^|[^\p{L}])(?:hamster|chuột hamster|chuột)(?=$|[^\p{L}])/iu.test(raw) || /\b(?:hamster|chuot)\b/.test(folded),
        rabbit: /(?:^|[^\p{L}])(?:thỏ|tho|rabbit|rabbits)(?=$|[^\p{L}])/iu.test(raw),
    };
}

function searchSignals(query, keywords) {
    const sources = [query || '', ...keywords];
    const folded = sources.map(normalizeText).join(' ');
    const excluded = new Set();
    for (const group of CONCEPTS) {
        if (!PRODUCT_TYPES.has(group[0])) continue;
        for (const alias of group) {
            if (new RegExp('\\bkhong(?:\\s+(?:lay|mua|chon|can|tim|muon|dung|thich|su dung))?\\s+' + alias + '\\b').test(folded)) excluded.add(group[0]);
        }
    }
    const terms = [...new Set(sources.flatMap(searchTerms))].filter(term => !excluded.has(term));
    return { terms, types: terms.filter(term => PRODUCT_TYPES.has(term)), excluded, species: species(sources.join(' ')) };
}

function matchesType(row, type) {
    const name = normalizeText(row.name), category = normalizeText(row.category_name), description = normalizeText(row.description);
    if (FOOD_TYPES.has(type) && (NON_FOOD_CATEGORY.test(category) || NON_FOOD_NAME.test(name) || FOOD_CONTAINER.test(name))) return false;
    const aliases = type === 'thuc an'
        ? CONCEPTS.filter(group => FOOD_TYPES.has(group[0])).flat()
        : CONCEPTS.find(group => group[0] === type);
    if (aliases.some(alias => contains(name, alias) || contains(category, alias))) return true;
    // A generic product title can still be established by its description,
    // unless that text only describes storing or dispensing food.
    return (!FOOD_TYPES.has(type) || !FOOD_CONTAINER.test(description)) && aliases.some(alias => contains(description, alias));
}

function matchesSignals(row, signals) {
    if (signals.types.length && !signals.types.some(type => matchesType(row, type))) return false;
    if ([...signals.excluded].some(type => matchesType(row, type))) return false;
    // Species facts come from catalog relations, never guesses from prose.
    const detectedSpecies = Object.entries(signals.species).filter(([, active]) => active).map(([slug]) => slug);
    if (detectedSpecies.length === 1 && !row.pet_types.some(pet => pet.slug === detectedSpecies[0])) return false;
    return true;
}

function relevance(row, terms, query) {
    const name = normalizeText(row.name), category = normalizeText(row.category_name);
    const description = normalizeText([row.description, ...row.pet_types.flatMap(pet => [pet.name, pet.slug])].join(' '));
    if (!terms.length) return 1;
    let score = 0;
    for (const term of terms) {
        const variants = CONCEPTS.find(group => group[0] === term) || [term];
        score += Math.max(...variants.map(alias => contains(name, alias) ? 12 : contains(category, alias) ? 7 : contains(description, alias) ? 2 : 0));
    }
    if (!score) return 0;
    if (query && contains(name, query)) score += 20;
    return score;
}

function createProductRepository({ db, categoryReader } = {}) {
    return {
        async listCategories() {
            // Reuse the existing read-only catalog model in production. Resolve
            // it lazily so an injected repository never opens a real DB pool.
            if (db && !categoryReader) throw new Error('An injected category reader is required with an injected database');
            return measure('mysql_products_ms', () => (categoryReader || require('../models/catalog').listCategories)());
        },
        // Exact references must not pass through relevance ranking or hide an
        // out-of-stock item. The bound placeholders contain IDs only.
        async getByIds(productIds, { signal } = {}) {
            checkSignal(signal);
            if (!Array.isArray(productIds) || productIds.length < 1 || productIds.length > 6 ||
                new Set(productIds).size !== productIds.length || productIds.some(id => !Number.isInteger(id) || id < 1 || id > 2147483647)) invalid('Invalid product IDs');
            const connection = db || defaultDatabase();
            const [rows] = await measure('mysql_products_ms', () => connection.execute(`SELECT /*+ MAX_EXECUTION_TIME(8000) */ p.product_id, p.category_id, c.name AS category_name,
                p.name, p.price, p.stock_quantity, LEFT(p.description, ${DESCRIPTION_LIMIT}) AS description,
                p.image_url, p.status, p.created_at, ${PET_TYPES_SQL} FROM products p
                JOIN categories c ON c.category_id = p.category_id
                WHERE p.status = ? AND p.product_id IN (${productIds.map(() => '?').join(', ')}) LIMIT 6`, [ACTIVE_STATUS, ...productIds]));
            checkSignal(signal);
            const found = new Map(rows.filter(row => row.status === ACTIVE_STATUS && productIds.includes(row.product_id)).map(classified).map(row => [row.product_id, row]));
            return productIds.filter(id => found.has(id)).map(id => found.get(id));
        },
        // The stock option belongs to internal context construction, not filters.
        async search(input = {}, { includeOutOfStock = false, signal } = {}) {
            checkSignal(signal);
            const filters = validateFilters(input);
            const signals = searchSignals(filters.query, filters.keywords);
            if (filters.species) {
                signals.species = Object.fromEntries(PET_SPECIES.map(slug => [slug, slug === filters.species]));
            }
            const detectedSpecies = Object.entries(signals.species).filter(([, active]) => active).map(([slug]) => slug);
            const speciesFilter = filters.species || (detectedSpecies.length === 1 ? detectedSpecies[0] : null);
            if (filters.productIds && !filters.productIds.length) return { products: [], totalMatches: 0, catalogLimited: false };
            const conditions = ['p.status = ?'];
            const params = [ACTIVE_STATUS];
            if (!includeOutOfStock) conditions.push('p.stock_quantity > 0');
            if (filters.categoryId !== undefined) { conditions.push('p.category_id = ?'); params.push(filters.categoryId); }
            if (filters.minPrice !== undefined) { conditions.push('p.price >= ?'); params.push(filters.minPrice); }
            if (filters.maxPrice !== undefined) { conditions.push('p.price <= ?'); params.push(filters.maxPrice); }
            if (filters.productIds) { conditions.push(`p.product_id IN (${filters.productIds.map(() => '?').join(', ')})`); params.push(...filters.productIds); }
            if (speciesFilter) {
                conditions.push('EXISTS (SELECT 1 FROM product_pet_types ppt JOIN pet_types pt ON pt.pet_type_id = ppt.pet_type_id WHERE ppt.product_id = p.product_id AND pt.slug = ?)');
                params.push(speciesFilter);
            }
            // Explicit typed filters supplied by the conversational model and
            // validated memory take precedence over incidental query words.
            // The existing normalization/ranking remains retrieval-only.
            if (filters.productType) signals.types = [TYPED_PRODUCT_TYPES[filters.productType]];
            const terms = signals.terms;
            const query = normalizeText(filters.query);
            const category = filters.category && normalizeText(filters.category);
            const ids = filters.productIds && new Set(filters.productIds);
            const compare = (a, b) => {
                if (filters.sort === 'price_asc' || filters.sort === 'price_desc') {
                    const difference = toCents(a.row.price) - toCents(b.row.price);
                    if (difference) return (difference < 0n ? -1 : 1) * (filters.sort === 'price_desc' ? -1 : 1);
                }
                return b.score - a.score || a.row.product_id - b.row.product_id;
            };
            const best = [];
            let totalMatches = 0, cursor = 0;
            const connection = db || defaultDatabase();
            // Scan every active row by keyset, retaining only one SQL page and
            // the best six candidates. There is no first-100-row cutoff.
            while (true) {
                checkSignal(signal);
                const [rows] = await measure('mysql_products_ms', () => connection.execute(`SELECT /*+ MAX_EXECUTION_TIME(8000) */ p.product_id, p.category_id, c.name AS category_name,
                    p.name, p.price, p.stock_quantity, LEFT(p.description, ${DESCRIPTION_LIMIT}) AS description,
                    p.image_url, p.status, p.created_at, ${PET_TYPES_SQL} FROM products p
                    JOIN categories c ON c.category_id = p.category_id
                    WHERE ${conditions.join(' AND ')} AND p.product_id > ? ORDER BY p.product_id ASC LIMIT ${PAGE_SIZE}`, [...params, cursor]));
                checkSignal(signal);
                for (const raw of rows) {
                    const row = classified(raw);
                    if (row.product_id <= cursor || row.status !== ACTIVE_STATUS || (!includeOutOfStock && !(row.stock_quantity > 0))) continue;
                    if (speciesFilter && !row.pet_types.some(pet => pet.slug === speciesFilter)) continue;
                    if (ids && !ids.has(row.product_id)) continue;
                    if (filters.categoryId !== undefined && row.category_id !== filters.categoryId) continue;
                    if (category && !normalizeText(row.category_name).includes(category)) continue;
                    if (filters.minPrice !== undefined && toCents(row.price) < toCents(filters.minPrice)) continue;
                    if (filters.maxPrice !== undefined && toCents(row.price) > toCents(filters.maxPrice)) continue;
                    if (!matchesSignals(row, signals)) continue;
                    const score = relevance(row, terms, query);
                    if (!score) continue;
                    totalMatches++;
                    best.push({ row, score });
                    best.sort(compare);
                    if (best.length > filters.limit) best.pop();
                }
                if (rows.length < PAGE_SIZE) break;
                const next = Math.max(...rows.map(row => Number(row.product_id)));
                if (next <= cursor) throw new Error('Invalid catalog page');
                cursor = next;
            }
            return { products: best.map(match => match.row), totalMatches, catalogLimited: false };
        }
    };
}
module.exports = { createProductRepository, normalizeText, validateFilters, searchTerms, PET_SPECIES };
