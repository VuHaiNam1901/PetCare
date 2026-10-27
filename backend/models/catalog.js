const pool = require('../config/db');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const productFields = ['category_id', 'name', 'description', 'price', 'stock_quantity', 'image_url', 'status'];
const categoryFields = ['name', 'description'];

async function mutation(adminId, action) {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[admin]] = await db.execute('SELECT role, status FROM `user` WHERE user_id = ? FOR SHARE', [adminId]);
        if (!admin || admin.role !== 'admin' || admin.status !== 'active') fail(403, 'Active admin account required');
        const result = await action(db);
        await db.commit();
        return result;
    } catch (error) {
        await db.rollback();
        if (error.code === 'ER_DUP_ENTRY') { error.status = 409; error.message = 'Category name already exists'; }
        if (['ER_ROW_IS_REFERENCED_2', 'ER_NO_REFERENCED_ROW_2'].includes(error.code)) { error.status = 409; error.message = 'Linked catalog data prevents this operation'; }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) { error.status = 409; error.message = 'Catalog is busy; retry the request'; }
        throw error;
    } finally { db.release(); }
}

async function requireCategory(db, categoryId) {
    const [rows] = await db.execute('SELECT category_id FROM categories WHERE category_id = ? FOR SHARE', [categoryId]);
    if (!rows.length) fail(400, 'Category does not exist');
}
async function product(db, productId) {
    const [[row]] = await db.execute(`SELECT p.*, c.name AS category_name FROM products p
        JOIN categories c ON c.category_id = p.category_id WHERE p.product_id = ?`, [productId]);
    return row;
}
async function category(db, categoryId) {
    const [[row]] = await db.execute('SELECT category_id, name, description, created_at FROM categories WHERE category_id = ?', [categoryId]);
    return row;
}

exports.createProduct = (adminId, data) => mutation(adminId, async db => {
    await requireCategory(db, data.category_id);
    const [result] = await db.execute(`INSERT INTO products
        (category_id, name, description, price, stock_quantity, image_url, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`, productFields.map(field => data[field]));
    return product(db, result.insertId);
});
exports.updateProduct = (adminId, productId, data) => mutation(adminId, async db => {
    const [rows] = await db.execute('SELECT product_id FROM products WHERE product_id = ? FOR UPDATE', [productId]);
    if (!rows.length) fail(404, 'Product not found');
    if (Object.hasOwn(data, 'category_id')) await requireCategory(db, data.category_id);
    const fields = productFields.filter(field => Object.hasOwn(data, field));
    await db.execute(`UPDATE products SET ${fields.map(field => `\`${field}\` = ?`).join(', ')} WHERE product_id = ?`, [...fields.map(field => data[field]), productId]);
    return product(db, productId);
});
// Never hard-delete products: retain order/cart/review references and image files.
exports.stopProduct = (adminId, productId) => exports.updateProduct(adminId, productId, { status: 'Ngừng bán' });

exports.listProducts = async filters => {
    const conditions = [];
    const params = [];
    if (filters.q !== undefined) {
        conditions.push("p.name LIKE ? ESCAPE '='");
        params.push('%' + filters.q.replace(/[=%_]/g, char => '=' + char) + '%');
    }
    for (const [key, condition] of [['category_id', 'p.category_id = ?'], ['status', 'p.status = ?'], ['min_price', 'p.price >= ?'], ['max_price', 'p.price <= ?']]) {
        if (filters[key] !== undefined) { conditions.push(condition); params.push(filters[key]); }
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM products p ${where}`, params);
        const [products] = await db.query(`SELECT p.*, c.name AS category_name FROM products p
            JOIN categories c ON c.category_id = p.category_id ${where}
            ORDER BY p.product_id DESC LIMIT ? OFFSET ?`, [...params, filters.limit, (filters.page - 1) * filters.limit]);
        await db.commit();
        return { total, products };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};

exports.listCategories = async () => (await pool.execute('SELECT category_id, name, description, created_at FROM categories ORDER BY category_id'))[0];
exports.createCategory = (adminId, data) => mutation(adminId, async db => {
    const [result] = await db.execute('INSERT INTO categories (name, description, created_at) VALUES (?, ?, NOW())', [data.name, data.description]);
    return category(db, result.insertId);
});
exports.updateCategory = (adminId, categoryId, data) => mutation(adminId, async db => {
    const [rows] = await db.execute('SELECT category_id FROM categories WHERE category_id = ? FOR UPDATE', [categoryId]);
    if (!rows.length) fail(404, 'Category not found');
    const fields = categoryFields.filter(field => Object.hasOwn(data, field));
    await db.execute(`UPDATE categories SET ${fields.map(field => `\`${field}\` = ?`).join(', ')} WHERE category_id = ?`, [...fields.map(field => data[field]), categoryId]);
    return category(db, categoryId);
});
exports.removeCategory = (adminId, categoryId) => mutation(adminId, async db => {
    const [rows] = await db.execute('SELECT category_id FROM categories WHERE category_id = ? FOR UPDATE', [categoryId]);
    if (!rows.length) fail(404, 'Category not found');
    const [products] = await db.execute('SELECT product_id FROM products WHERE category_id = ? LIMIT 1', [categoryId]);
    if (products.length) fail(409, 'Category still contains products, including discontinued products');
    await db.execute('DELETE FROM categories WHERE category_id = ?', [categoryId]);
    return { category_id: categoryId, deleted: true };
});
