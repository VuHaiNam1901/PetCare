const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

test('cart integration: ownership, validation, concurrency and unchanged catalog', async () => {
    const emails = [0, 1].map(() => `cart-test-${randomUUID()}@example.com`);
    const server = app.listen(0, '127.0.0.1');
    const accounts = [];
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, method = 'GET', body, token = accounts[0]?.token) {
        const response = await fetch(base + path, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { status: response.status, data: await response.json() };
    }
    async function snapshot() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categoryCount: categories.length, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    try {
        const before = await snapshot();
        const product = before.products.find(p => p.status === 'Đang bán' && p.stock_quantity >= 10);
        assert.ok(product, 'An existing product with at least 10 stock is needed; no catalog fixtures are inserted');
        for (const email of emails) {
            const registered = await request('/api/auth/register', 'POST', { full_name: 'Cart test', email, password: 'Cart-test-2026!' }, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email, password: 'Cart-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        for (const token of [null, 'invalid', jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 })]) {
            for (const [path, method, body] of [['/api/cart', 'GET'], ['/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1 }], ['/api/cart/items/1', 'PUT', { quantity: 1 }], ['/api/cart/items/1', 'DELETE']]) {
                assert.equal((await request(path, method, body, token)).status, 401);
            }
        }
        assert.deepEqual((await request('/api/cart')).data.cart, { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00' });
        // Simultaneous requests exercise cart creation and item insertion without UNIQUE(cart_id,product_id).
        const additions = await Promise.all(Array.from({ length: 5 }, () => request('/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1 })));
        additions.forEach(result => assert.equal(result.status, 200));
        let cart = (await request('/api/cart')).data.cart;
        assert.equal(cart.items.length, 1);
        assert.equal(cart.items[0].quantity, 5);
        assert.equal(cart.items[0].price, product.price);
        assert.equal(Number(cart.subtotal), Number(product.price) * 5);
        const item = cart.items[0].cart_item_id;
        const [[counts]] = await pool.execute('SELECT COUNT(*) AS count FROM carts WHERE user_id = ?', [accounts[0].id]);
        assert.equal(counts.count, 1);
        assert.equal((await request('/api/cart/items', 'POST', { product_id: product.product_id, quantity: 2 })).data.cart.items[0].quantity, 7);
        assert.equal((await request(`/api/cart/items/${item}`, 'PUT', { quantity: 3 })).data.cart.items[0].quantity, 3);
        for (const quantity of [0, -1, 1.5, '2', null, 2147483648]) {
            assert.equal((await request('/api/cart/items', 'POST', { product_id: product.product_id, quantity })).status, 400);
            assert.equal((await request(`/api/cart/items/${item}`, 'PUT', { quantity })).status, 400);
        }
        assert.equal((await request('/api/cart/items', 'POST', { product_id: product.product_id, quantity: product.stock_quantity })).status, 409);
        assert.equal((await request(`/api/cart/items/${item}`, 'PUT', { quantity: product.stock_quantity + 1 })).status, 409);
        assert.equal((await request('/api/cart/items', 'POST', { product_id: 2147483647, quantity: 1 })).status, 404);
        const unavailable = before.products.find(p => p.status !== 'Đang bán');
        if (unavailable) {
            assert.equal((await request('/api/cart/items', 'POST', { product_id: unavailable.product_id, quantity: 1 })).status, 409);
        } else {
            console.log('Unavailable-product integration case not exercised: all existing products are for sale; catalog fixtures are not modified.');
        }
        for (const extra of [{ user_id: accounts[1].id }, { price: 1 }, { selected: 1 }]) assert.equal((await request('/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1, ...extra })).status, 400);
        assert.equal((await request('/api/cart?user_id=1')).status, 400);
        assert.equal((await request('/api/cart/items/bad', 'PUT', { quantity: 1 })).status, 400);
        assert.equal((await request('/api/cart', 'GET', undefined, accounts[1].token)).data.cart.items.length, 0);
        assert.equal((await request(`/api/cart/items/${item}`, 'PUT', { quantity: 1 }, accounts[1].token)).status, 404);
        assert.equal((await request(`/api/cart/items/${item}`, 'DELETE', undefined, accounts[1].token)).status, 404);
        assert.equal((await request('/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1 }, accounts[1].token)).status, 200);
        assert.equal((await request('/api/cart')).data.cart.items[0].quantity, 3);
        // Temporary role change only, never create a default administrator.
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[1].id]);
        for (const [path, method, body] of [['/api/cart', 'GET'], ['/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1 }], [`/api/cart/items/${item}`, 'PUT', { quantity: 1 }], [`/api/cart/items/${item}`, 'DELETE']]) assert.equal((await request(path, method, body, accounts[1].token)).status, 403);
        assert.equal((await request(`/api/cart/items/${item}`, 'DELETE')).status, 200);
        assert.equal((await request('/api/cart')).data.cart.items.length, 0);
        assert.equal((await request(`/api/cart/items/${item}`, 'DELETE')).status, 404);
        for (const path of ['/', '/api/health/db', '/api/health/tables', '/api/products', '/api/categories']) assert.equal((await request(path, 'GET', undefined, null)).status, 200);
        const after = await snapshot();
        assert.equal(after.hash, before.hash);
        console.log(`Catalog unchanged: ${after.products.length} products, ${after.categoryCount} categories (including stock).`);
    } finally {
        try {
            for (const email of emails) {
                await pool.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id = ci.cart_id JOIN `user` u ON u.user_id = c.user_id WHERE u.email = ?', [email]);
                await pool.execute('DELETE c FROM carts c JOIN `user` u ON u.user_id = c.user_id WHERE u.email = ?', [email]);
                await pool.execute('DELETE FROM `user` WHERE email = ?', [email]);
            }
            const [remaining] = await pool.execute('SELECT user_id FROM `user` WHERE email IN (?, ?)', emails);
            assert.equal(remaining.length, 0);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
