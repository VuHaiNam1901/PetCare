const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const bcrypt = require('bcrypt');
const app = require('../server');
const pool = require('../config/db');

test('guest preview, real auth, atomic account merge/replay, selections and ownership', { timeout: 90000 }, async () => {
    const emails = [0, 1].map(() => `cart-merge-test-${randomUUID()}@example.com`);
    const accounts = [];
    const fixtureProducts = [];
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const password = 'Cart-merge-test-2026!';
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    async function request(path, method = 'GET', body, token = accounts[0]?.token, key) {
        const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        assert.equal(/"password"|"\$2[aby]\$/.test(JSON.stringify(data)), false);
        return { status: response.status, data };
    }
    async function originalRows() {
        const tables = ['user', 'carts', 'cart_items', 'products', 'categories', 'orders', 'order_details', 'payments'];
        const result = {};
        for (const table of tables) {
            const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
            result[table] = rows;
        }
        return digest(result);
    }
    const before = await originalRows();
    try {
        const [existing] = await pool.query('SELECT product_id, category_id, price, stock_quantity, status FROM products WHERE status = ? AND stock_quantity >= 10 ORDER BY product_id', ['Đang bán']);
        assert.ok(existing.length >= 3, 'Three existing in-stock products are needed; original catalog is never modified');
        const [a, b, c] = existing;
        for (const email of emails) {
            assert.equal((await request('/api/auth/register', 'POST', { full_name: 'Cart merge test', email, password, role: 'admin' }, null)).status, 400);
            const registration = await request('/api/auth/register', 'POST', { full_name: 'Cart merge test', email, password }, null);
            assert.equal(registration.status, 201);
            assert.equal(registration.data.user.role, 'user');
            const [[stored]] = await pool.execute('SELECT password FROM `user` WHERE user_id = ?', [registration.data.user.user_id]);
            assert.notEqual(stored.password, password);
            assert.equal(await bcrypt.compare(password, stored.password), true);
            const login = await request('/api/auth/login', 'POST', { email, password }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registration.data.user.user_id, token: login.data.token });
            assert.equal((await request('/api/auth/me', 'GET', undefined, login.data.token)).data.user.user_id, registration.data.user.user_id);
        }
        for (const [path, method, body] of [['/api/cart', 'GET'], ['/api/cart/merge', 'POST', { items: [] }], ['/api/cart/selection', 'PUT', { product_ids: [] }]]) assert.equal((await request(path, method, body, null, randomUUID())).status, 401);
        assert.equal((await request('/api/cart/preview', 'POST', { items: [] }, null)).data.cart.items.length, 0);
        const preview = await request('/api/cart/preview', 'POST', { items: [{ product_id: a.product_id, quantity: 2, selected: true }, { product_id: 2147483647, quantity: 1, selected: true }] }, null);
        assert.equal(preview.status, 200);
        assert.equal(preview.data.cart.items[0].price, a.price);
        assert.equal(Number(preview.data.cart.items[0].line_total), Number(a.price) * 2);
        assert.equal(preview.data.cart.items[1].available, false);
        assert.equal(preview.data.cart.items[1].selected, false);
        assert.equal(preview.data.cart.items[1].price, null);
        assert.equal(preview.data.cart.selected_count, 1);
        for (const quantity of [0, -1, 1.5, '2', null, 2147483648]) {
            const body = { items: [{ product_id: a.product_id, quantity, selected: true }] };
            assert.equal((await request('/api/cart/preview', 'POST', body, null)).status, 400);
            assert.equal((await request('/api/cart/merge', 'POST', body, undefined, randomUUID())).status, 400);
        }
        assert.equal((await request('/api/cart/preview', 'POST', { items: [{ product_id: a.product_id, quantity: 1, price: 1 }] }, null)).status, 400);
        assert.equal((await request('/api/cart/merge', 'POST', { items: [], user_id: accounts[1].id }, undefined, randomUUID())).status, 400);
        assert.equal((await request('/api/cart/merge', 'POST', { items: [] })).status, 400);
        assert.equal((await request('/api/cart/preview', 'POST', { items: [{ product_id: a.product_id, quantity: 1 }, { product_id: a.product_id, quantity: 2 }] }, null)).status, 400);
        assert.equal((await request('/api/cart/preview', 'POST', { items: [{ product_id: a.product_id, quantity: 1, selected: 1 }] }, null)).status, 400);

        await request('/api/cart/items', 'POST', { product_id: a.product_id, quantity: 1 });
        await request('/api/cart/items', 'POST', { product_id: b.product_id, quantity: 2 });
        assert.equal((await request('/api/cart/selection', 'PUT', { product_ids: [a.product_id, b.product_id] })).data.cart.selected_count, 2);
        const guest = { items: [{ product_id: a.product_id, quantity: 2, selected: false }, { product_id: c.product_id, quantity: 3, selected: true }] };
        const key = randomUUID();
        const merged = await Promise.all([request('/api/cart/merge', 'POST', guest, undefined, key), request('/api/cart/merge', 'POST', guest, undefined, key)]);
        assert.deepEqual(merged.map(result => result.status), [200, 200]);
        assert.deepEqual(merged.map(result => result.data.replayed).sort(), [false, true]);
        let cart = (await request('/api/cart')).data.cart;
        assert.deepEqual(cart.items.map(item => [item.product_id, item.quantity, item.selected]), [[a.product_id, 3, false], [b.product_id, 2, false], [c.product_id, 3, true]]);
        assert.equal(cart.selected_count, 1);
        assert.equal(cart.selected_quantity, 3);
        assert.equal(Number(cart.selected_subtotal), Number(c.price) * 3);
        const itemC = cart.items.find(item => item.product_id === c.product_id);
        assert.equal((await request(`/api/cart/items/${itemC.cart_item_id}`, 'PUT', { quantity: 2 })).status, 200);
        const replay = await request('/api/cart/merge', 'POST', { items: [...guest.items].reverse() }, undefined, key);
        assert.equal(replay.data.replayed, true);
        assert.equal(replay.data.cart.items.find(item => item.product_id === c.product_id).quantity, 2, 'Replay returns fresh cart without applying a second time');
        assert.equal((await request('/api/cart/merge', 'POST', { items: [{ ...guest.items[0], quantity: 1 }] }, undefined, key)).status, 409);

        const beforeConflict = digest((await request('/api/cart')).data.cart);
        const conflictKey = randomUUID();
        const conflict = await request('/api/cart/merge', 'POST', { items: [{ product_id: a.product_id, quantity: a.stock_quantity, selected: true }, { product_id: c.product_id, quantity: 1, selected: true }] }, undefined, conflictKey);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.data.conflicts[0].product_id, a.product_id);
        assert.equal(conflict.data.conflicts[0].account_quantity, 3);
        assert.equal(conflict.data.conflicts[0].requested_quantity, a.stock_quantity + 3);
        assert.equal(digest((await request('/api/cart')).data.cart), beforeConflict, 'No partial cart or selection updates on conflict');
        assert.equal((await request('/api/cart/merge', 'POST', { items: [{ product_id: a.product_id, quantity: 1, selected: true }] }, undefined, conflictKey)).status, 200, 'Failed keys are not committed');
        assert.equal((await request('/api/cart/merge', 'POST', { items: [] }, undefined, randomUUID())).data.cart.selected_count, 1, 'Empty guest does not clear account choices');

        cart = (await request('/api/cart')).data.cart;
        const itemA = cart.items.find(item => item.product_id === a.product_id);
        assert.equal((await request(`/api/cart/items/${itemA.cart_item_id}`, 'PUT', { quantity: 1 }, accounts[1].token)).status, 404);
        assert.equal((await request(`/api/cart/items/${itemA.cart_item_id}`, 'DELETE', undefined, accounts[1].token)).status, 404);
        assert.equal((await request('/api/cart/selection', 'PUT', { product_ids: [a.product_id] }, accounts[1].token)).status, 404);
        const otherConflict = await request('/api/cart/merge', 'POST', { items: [{ product_id: b.product_id, quantity: 1, selected: true }, { product_id: 2147483647, quantity: 1, selected: true }] }, accounts[1].token, randomUUID());
        assert.equal(otherConflict.status, 409);
        assert.equal((await request('/api/cart', 'GET', undefined, accounts[1].token)).data.cart.cart_id, null, 'Failed initial merge must not create a cart');

        const [created] = await pool.execute('INSERT INTO products (category_id, name, description, price, stock_quantity, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())', [a.category_id, `Cart test ${randomUUID()}`, null, '1.25', 3, '/images/products/cart-test.webp', 'Đang bán']);
        fixtureProducts.push(created.insertId);
        assert.equal((await request('/api/cart/items', 'POST', { product_id: created.insertId, quantity: 1 })).status, 200);
        await pool.execute('UPDATE products SET status = ? WHERE product_id = ?', ['Ngừng bán', created.insertId]);
        cart = (await request('/api/cart')).data.cart;
        const stopped = cart.items.find(item => item.product_id === created.insertId);
        assert.equal(stopped.available, false);
        assert.equal(stopped.selected, false);
        assert.ok(stopped.name.startsWith('Cart test'));
        assert.equal((await request('/api/cart/selection', 'PUT', { product_ids: [created.insertId] })).status, 409);
        assert.equal((await request(`/api/cart/items/${stopped.cart_item_id}`, 'PUT', { quantity: 1 })).status, 409);
        const stoppedMerge = await request('/api/cart/merge', 'POST', { items: [{ product_id: created.insertId, quantity: 1, selected: true }] }, undefined, randomUUID());
        assert.equal(stoppedMerge.status, 409);
        assert.equal(stoppedMerge.data.conflicts[0].status, 'Ngừng bán');
        assert.equal((await request('/api/cart/preview', 'POST', { items: [{ product_id: created.insertId, quantity: 1, selected: true }] }, null)).data.cart.items[0].available, false);
        assert.equal((await request(`/api/cart/items/${stopped.cart_item_id}`, 'DELETE')).status, 200);

        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[1].id]);
        for (const [path, method, body] of [['/api/cart', 'GET'], ['/api/cart/merge', 'POST', { items: [] }], ['/api/cart/selection', 'PUT', { product_ids: [] }]]) assert.equal((await request(path, method, body, accounts[1].token, randomUUID())).status, 403);
        assert.equal((await request('/api/cart/preview', 'POST', { items: [] }, accounts[1].token)).status, 200);
        console.log('Real auth, merge transaction/replay/concurrency, ownership and stale catalog checks passed.');
    } finally {
        try {
            for (const email of emails) {
                await pool.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id = ci.cart_id JOIN `user` u ON u.user_id = c.user_id WHERE u.email = ?', [email]);
                await pool.execute('DELETE c FROM carts c JOIN `user` u ON u.user_id = c.user_id WHERE u.email = ?', [email]);
                await pool.execute('DELETE FROM `user` WHERE email = ?', [email]);
            }
            for (const productId of fixtureProducts) await pool.execute('DELETE FROM products WHERE product_id = ?', [productId]);
            assert.equal(await originalRows(), before, 'All original rows including catalog, stock, users, carts and orders remain identical');
            console.log('Original database row hashes unchanged after temporary fixture cleanup.');
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
