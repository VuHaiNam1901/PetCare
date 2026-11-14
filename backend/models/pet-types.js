const pool = require('../config/db');

const types = [
    { pet_type_id: 1, slug: 'dog', name: 'Chó' },
    { pet_type_id: 2, slug: 'cat', name: 'Mèo' },
    { pet_type_id: 3, slug: 'bird', name: 'Chim' },
    { pet_type_id: 4, slug: 'fish', name: 'Cá' },
    { pet_type_id: 5, slug: 'hamster', name: 'Hamster/Chuột' },
    { pet_type_id: 6, slug: 'rabbit', name: 'Thỏ' },
];
const unavailable = () => Object.assign(new Error('Pet classification is not ready'), { status: 503, code: 'PET_TYPES_NOT_READY' });

// Readiness never applies a migration. Old catalog operations remain available
// until the two additive tables and the six reference rows have been approved.
async function state(db = pool) {
    let rows;
    try {
        [rows] = await db.execute(`SELECT pt.pet_type_id,pt.slug,pt.name,
            COUNT(CASE WHEN p.status = ? THEN 1 END) AS product_count
            FROM pet_types pt LEFT JOIN product_pet_types ppt ON ppt.pet_type_id=pt.pet_type_id
            LEFT JOIN products p ON p.product_id=ppt.product_id
            GROUP BY pt.pet_type_id,pt.slug,pt.name ORDER BY pt.pet_type_id`, ['Đang bán']);
    } catch (error) {
        if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.code)) return { ready: false, pet_types: [] };
        throw error;
    }
    const ready = rows.length === types.length && types.every(type => rows.some(row => row.pet_type_id === type.pet_type_id && row.slug === type.slug && row.name === type.name));
    return { ready, pet_types: ready ? rows.map(row => ({ ...row, product_count: Number(row.product_count) })) : [] };
}

async function attach(db, products, knownState) {
    const current = knownState || await state(db);
    const byProduct = new Map(products.map(product => [product.product_id, []]));
    if (current.ready && products.length) {
        const [links] = await db.execute(`SELECT product_id,pet_type_id FROM product_pet_types
            WHERE product_id IN (${products.map(() => '?').join(',')}) ORDER BY pet_type_id`, products.map(product => product.product_id));
        for (const link of links) byProduct.get(link.product_id).push(link.pet_type_id);
    }
    return { pet_types_ready: current.ready, products: products.map(product => ({ ...product, pet_type_ids: byProduct.get(product.product_id) })) };
}

// The caller already holds the product's FOR UPDATE lock. Replacing its links
// in the same transaction serializes concurrent edits and preserves partial PUTs.
async function replace(db, productId, ids) {
    if (!(await state(db)).ready) throw unavailable();
    if (ids.length) {
        const [found] = await db.execute(`SELECT pet_type_id FROM pet_types WHERE pet_type_id IN (${ids.map(() => '?').join(',')}) FOR SHARE`, ids);
        if (found.length !== ids.length) throw Object.assign(new Error('Unknown pet type'), { status: 400 });
    }
    await db.execute('DELETE FROM product_pet_types WHERE product_id=?', [productId]);
    if (ids.length) await db.query('INSERT INTO product_pet_types (product_id,pet_type_id) VALUES ?', [ids.map(id => [productId, id])]);
}

async function list({ availableOnly = true } = {}) {
    const current = await state();
    const pet_types = availableOnly ? current.pet_types.filter(type => type.product_count > 0) : current.pet_types;
    return { ready: current.ready, total: pet_types.length, pet_types };
}

module.exports = { types, state, attach, replace, list, unavailable };
