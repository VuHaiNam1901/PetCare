const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

test('admin catalog: validation, references, search, history preservation and cleanup', async () => {
    const emails = [0, 1].map(() => `catalog-test-${randomUUID()}@example.com`);
    const accounts = [];
    const categoryIds = new Set();
    const productIds = new Set();
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let before;
    async function snapshot() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function request(url, method = 'GET', body, token = accounts[0]?.token, key) {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const result = { status: response.status, data: await response.json() };
        if (method === 'POST' && result.status === 201) {
            if (url === '/api/admin/categories') categoryIds.add(result.data.category.category_id);
            if (url === '/api/admin/products') productIds.add(result.data.product.product_id);
        }
        return result;
    }
    try {
        before = await snapshot();
        for (const email of emails) {
            const registered = await request('/api/auth/register', 'POST', { full_name: 'Catalog test', email, password: 'Catalog-test-2026!' }, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email, password: 'Catalog-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[0].id]);
        const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 });
        for (const [url, method, body] of [
            ['/api/admin/products', 'GET'], ['/api/admin/products', 'POST', {}], ['/api/admin/products/1', 'PUT', {}], ['/api/admin/products/1', 'DELETE'],
            ['/api/admin/categories', 'GET'], ['/api/admin/categories', 'POST', {}], ['/api/admin/categories/1', 'PUT', {}], ['/api/admin/categories/1', 'DELETE']
        ]) {
            assert.equal((await request(url, method, body, accounts[1].token)).status, 403);
            for (const token of [null, 'invalid', expired]) assert.equal((await request(url, method, body, token)).status, 401);
        }
        const prefix = `Catalog-${randomUUID()}`;
        const createdCategory = await request('/api/admin/categories', 'POST', { name: prefix, description: 'Temporary category' });
        assert.equal(createdCategory.status, 201);
        const categoryId = createdCategory.data.category.category_id;
        assert.equal((await request('/api/admin/categories', 'POST', { name: prefix })).status, 409);
        assert.equal((await request('/api/admin/categories', 'POST', { name: ' ' })).status, 400);
        assert.equal((await request('/api/admin/categories', 'POST', { name: prefix, unknown: 1 })).status, 400);
        assert.equal((await request(`/api/admin/categories/${categoryId}`, 'PUT', { name: prefix + '-renamed', description: null })).status, 200);
        assert.ok((await request('/api/admin/categories')).data.categories.some(category => category.category_id === categoryId));
        const valid = { name: prefix + '-product_100%', category_id: categoryId, description: 'Test description', price: '10.25', stock_quantity: 20, image_url: before.products[0].image_url, status: 'Đang bán' };
        for (const changes of [{ name: '' }, { name: 'a'.repeat(151) }, { price: -1 }, { price: '1.234' }, { price: '10000000000' }, { price: '1 OR 1=1' }, { stock_quantity: -1 }, { stock_quantity: 1.2 }, { stock_quantity: '2' }, { stock_quantity: 2147483648 }, { category_id: 0 }, { status: 'active' }, { image_url: 'https://example.com/a.webp' }, { image_url: '/images/products/../a.webp' }, { image_url: '/images/products/%2e%2e/a.webp' }, { image_url: '/images/products/a.svg' }, { image_url: '/images/products/a.webp?x=1' }, { description: '漢'.repeat(22000) }, { user_id: accounts[1].id }]) {
            assert.equal((await request('/api/admin/products', 'POST', { ...valid, ...changes })).status, 400);
        }
        assert.equal((await request('/api/admin/products', 'POST', { ...valid, category_id: 2147483647 })).status, 400);
        const created = await request('/api/admin/products', 'POST', valid);
        assert.equal(created.status, 201);
        const productId = created.data.product.product_id;
        assert.equal(created.data.product.price, '10.25');
        const zero = await request('/api/admin/products', 'POST', { ...valid, name: prefix + '-zero', price: 0, stock_quantity: 0 });
        assert.equal(zero.status, 201);
        assert.equal(zero.data.product.price, '0.00');
        const search = '/api/admin/products?q=' + encodeURIComponent('_100%') + `&category_id=${categoryId}&status=${encodeURIComponent('Đang bán')}&min_price=10&max_price=11&page=1&limit=1`;
        const listed = await request(search);
        assert.equal(listed.status, 200);
        assert.equal(listed.data.total, 1);
        assert.equal(listed.data.products[0].product_id, productId);
        assert.equal((await request('/api/admin/products?q=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
        assert.equal((await request('/api/admin/products?page=0')).status, 400);
        assert.equal((await request('/api/admin/products?min_price=20&max_price=10')).status, 400);
        assert.equal((await request('/api/admin/products?status=invalid')).status, 400);
        assert.equal((await request(`/api/admin/products/${productId}`, 'PUT', {})).status, 400);
        assert.equal((await request('/api/admin/products/2147483647', 'PUT', { name: 'Missing' })).status, 404);
        assert.equal((await request(`/api/admin/products/${productId}`, 'PUT', { price: -1 })).status, 400);
        assert.equal((await request(`/api/admin/products/${productId}`, 'PUT', { category_id: 2147483647 })).status, 400);
        assert.equal((await request(`/api/admin/categories/${categoryId}`, 'DELETE')).status, 409);

        // Order and cart references are created only against temporary products.
        const cart = await request('/api/cart/items', 'POST', { product_id: productId, quantity: 2 }, accounts[1].token);
        assert.equal(cart.status, 200);
        const order = await request('/api/orders', 'POST', { cart_item_ids: [cart.data.cart.items[0].cart_item_id], shipping_address: '123 Catalog Test Street', phone: '0123456789', payment_method: 'COD' }, accounts[1].token, randomUUID());
        assert.equal(order.status, 201);
        const orderId = order.data.order.order_id;
        const [[originalOrder]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [orderId]);
        const [originalDetails] = await pool.execute('SELECT * FROM order_details WHERE order_id = ?', [orderId]);
        const [[originalPayment]] = await pool.execute('SELECT * FROM payments WHERE order_id = ?', [orderId]);
        assert.equal((await request(`/api/admin/products/${productId}`, 'PUT', { name: prefix + '-updated', description: null, price: '99.99', stock_quantity: 8 })).status, 200);
        const heldCart = await request('/api/cart/items', 'POST', { product_id: productId, quantity: 1 }, accounts[1].token);
        assert.equal(heldCart.status, 200);
        const heldItemId = heldCart.data.cart.items.find(item => item.product_id === productId).cart_item_id;
        assert.ok((await request('/api/products', 'GET', undefined, null)).data.products.some(product => product.product_id === productId));
        await pool.execute('INSERT INTO reviews (user_id, product_id, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())', [accounts[1].id, productId, 5, 'Temporary test review']);
        const stopped = await request(`/api/admin/products/${productId}`, 'DELETE');
        assert.equal(stopped.status, 200);
        assert.equal(stopped.data.action, 'discontinued');
        assert.equal(stopped.data.product.status, 'Ngừng bán');
        // Public visibility is fixed server-side, regardless of query or JWT role.
        for (const query of ['', '?status=' + encodeURIComponent('Ngừng bán'), '?status=all&include_inactive=true&show_all=1', '?status=' + encodeURIComponent("Đang bán' OR 1=1 --"), '?status[]=all']) {
            for (const token of [null, accounts[1].token, accounts[0].token]) {
                const visible = await request('/api/products' + query, 'GET', undefined, token);
                assert.equal(visible.status, 200);
                assert.equal(visible.data.total, visible.data.products.length);
                assert.ok(visible.data.products.every(product => product.status === 'Đang bán'));
                assert.equal(visible.data.products.some(product => product.product_id === productId), false);
                assert.ok(visible.data.products.some(product => product.product_id === zero.data.product.product_id));
            }
        }
        const allAdmin = await request(`/api/admin/products?category_id=${categoryId}`);
        assert.ok(allAdmin.data.products.some(product => product.product_id === productId && product.status === 'Ngừng bán'));
        assert.ok(allAdmin.data.products.some(product => product.status === 'Đang bán'));
        const stoppedAdmin = await request(`/api/admin/products?category_id=${categoryId}&status=` + encodeURIComponent('Ngừng bán'));
        assert.equal(stoppedAdmin.data.products[0].product_id, productId);
        assert.equal((await request(`/api/admin/products/${productId}`, 'DELETE')).status, 200);
        assert.equal((await request(`/api/admin/categories/${categoryId}`, 'DELETE')).status, 409);
        assert.equal((await request('/api/cart/items', 'POST', { product_id: productId, quantity: 1 }, accounts[1].token)).status, 409);
        assert.equal((await request(`/api/cart/items/${heldItemId}`, 'PUT', { quantity: 2 }, accounts[1].token)).status, 409);
        const refusedOrder = await request('/api/orders', 'POST', { cart_item_ids: [heldItemId], shipping_address: '123 Catalog Test Street', phone: '0123456789', payment_method: 'COD' }, accounts[1].token, randomUUID());
        assert.equal(refusedOrder.status, 409);
        assert.match(refusedOrder.data.message, /not available for sale/i);
        const [[remainingProduct]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [productId]);
        assert.equal(remainingProduct.stock_quantity, 8);
        const [[orderCount]] = await pool.execute('SELECT COUNT(*) AS count FROM orders WHERE user_id = ?', [accounts[1].id]);
        assert.equal(orderCount.count, 1, 'Rejected checkout must not create another order');
        assert.equal((await request('/api/cart', 'GET', undefined, accounts[1].token)).data.cart.items[0].product_id, productId);
        const [reviews] = await pool.execute('SELECT review_id FROM reviews WHERE product_id = ?', [productId]);
        assert.equal(reviews.length, 1);
        assert.deepEqual((await pool.execute('SELECT * FROM orders WHERE order_id = ?', [orderId]))[0][0], originalOrder);
        assert.deepEqual((await pool.execute('SELECT * FROM order_details WHERE order_id = ?', [orderId]))[0], originalDetails);
        assert.deepEqual((await pool.execute('SELECT * FROM payments WHERE order_id = ?', [orderId]))[0][0], originalPayment);
        assert.equal((await request(`/api/orders/${orderId}`, 'GET', undefined, accounts[1].token)).data.order.total_amount, '20.50');
        assert.ok((await request(`/api/orders/${orderId}`, 'GET', undefined, accounts[1].token)).data.order.items.some(item => item.product_id === productId));
        const history = await request('/api/orders', 'GET', undefined, accounts[1].token);
        assert.ok(history.data.orders.some(order => order.order_id === orderId && order.items.some(item => item.product_id === productId)));
        assert.equal((await request(`/api/admin/products/${productId}`, 'PUT', { status: 'Đang bán' })).status, 200);
        assert.ok((await request('/api/products', 'GET', undefined, null)).data.products.some(product => product.product_id === productId));

        const unused = await request('/api/admin/categories', 'POST', { name: prefix + '-unused' });
        assert.equal(unused.status, 201);
        const unusedId = unused.data.category.category_id;
        assert.equal((await request(`/api/admin/categories/${unusedId}`, 'PUT', { description: 'Updated' })).status, 200);
        assert.equal((await request(`/api/admin/categories/${unusedId}`, 'DELETE')).status, 200);
        assert.equal((await request(`/api/admin/categories/${unusedId}`, 'DELETE')).status, 404);
        const raceCategory = await request('/api/admin/categories', 'POST', { name: prefix + '-race' });
        assert.equal(raceCategory.status, 201);
        const raceId = raceCategory.data.category.category_id;
        const raced = await Promise.all([request('/api/admin/products', 'POST', { ...valid, category_id: raceId }), request(`/api/admin/categories/${raceId}`, 'DELETE')]);
        assert.ok((raced[0].status === 201 && raced[1].status === 409) || (raced[0].status === 400 && raced[1].status === 200));
        assert.equal((await request('/api/products', 'GET', undefined, null)).status, 200);
        assert.equal((await request('/api/categories', 'GET', undefined, null)).status, 200);
        console.log('Admin catalog CRUD, validation, category race, safe discontinuation and unchanged order/payment history verified.');
    } finally {
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email = ?', [email]);
                if (!user) continue;
                await db.execute('DELETE p FROM payments p JOIN orders o ON o.order_id=p.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE d FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM orders WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM reviews WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id=ci.cart_id WHERE c.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM carts WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM `user` WHERE user_id=?', [user.user_id]);
            }
            // Only IDs returned by successful creation of this test's fixtures.
            for (const productId of productIds) await db.execute('DELETE FROM products WHERE product_id=?', [productId]);
            for (const categoryId of categoryIds) await db.execute('DELETE FROM categories WHERE category_id=?', [categoryId]);
            await db.commit();
            if (before) {
                const after = await snapshot();
                assert.equal(after.hash, before.hash);
                console.log(`Catalog cleanup verified: ${after.products.length} products / ${after.categories.length} categories unchanged.`);
            }
            const [leftovers] = await db.execute('SELECT user_id FROM `user` WHERE email IN (?, ?)', emails);
            assert.equal(leftovers.length, 0);
        } catch (error) { await db.rollback(); throw error; }
        finally {
            db.release();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
