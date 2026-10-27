const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

test('UC19: customer listing, status locks, old JWT denial and history preservation', async () => {
    const prefix = `UC19-${randomUUID()}`;
    const emails = [0, 1, 2].map(i => `${prefix.toLowerCase()}-${i}@example.com`);
    const accounts = [];
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let before;
    let knownHashes = [];
    async function request(url, method = 'GET', body, token = accounts[0]?.token) {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        const serialized = JSON.stringify(data);
        assert.equal(/"password"|"password_hash"|\$2[aby]\$/.test(serialized), false);
        assert.equal(knownHashes.some(hash => serialized.includes(hash)), false);
        return { status: response.status, data };
    }
    const lock = (id, status) => request(`/api/admin/users/${id}/status`, 'PATCH', { status });
    async function catalog() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, digest: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function related(userId) {
        const output = {};
        for (const [key, sql] of Object.entries({
            carts: 'SELECT * FROM carts WHERE user_id=? ORDER BY cart_id',
            items: 'SELECT ci.* FROM cart_items ci JOIN carts c ON c.cart_id=ci.cart_id WHERE c.user_id=? ORDER BY ci.cart_item_id',
            orders: 'SELECT * FROM orders WHERE user_id=? ORDER BY order_id',
            details: 'SELECT d.* FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=? ORDER BY d.order_detail_id',
            payments: 'SELECT p.* FROM payments p JOIN orders o ON o.order_id=p.order_id WHERE o.user_id=? ORDER BY p.payment_id',
            reviews: 'SELECT * FROM reviews WHERE user_id=? ORDER BY review_id'
        })) output[key] = (await pool.execute(sql, [userId]))[0];
        return output;
    }
    try {
        before = await catalog();
        for (let i = 0; i < emails.length; i++) {
            const registered = await request('/api/auth/register', 'POST', { full_name: `${prefix}${i === 1 ? '_%' : ''} ${i}`, email: emails[i], password: 'User-management-test-2026!', phone: '0123456789', address: '123 User Test Street' }, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email: emails[i], password: 'User-management-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        await pool.execute('UPDATE `user` SET role=? WHERE user_id=?', ['admin', accounts[0].id]);
        const [passwords] = await pool.execute('SELECT password FROM `user` WHERE user_id IN (?, ?, ?)', accounts.map(account => account.id));
        knownHashes = passwords.map(row => row.password);
        const customer = accounts[1];
        // Synthetic history fixture only: no stock is reserved/updated and no
        // order/cancellation workflow is called for this fixture.
        const product = before.products[0];
        const [cart] = await pool.execute('INSERT INTO carts (user_id,created_at) VALUES (?,NOW())', [customer.id]);
        const [item] = await pool.execute('INSERT INTO cart_items (cart_id,product_id,quantity,selected,created_at) VALUES (?,?,1,0,NOW())', [cart.insertId, product.product_id]);
        const [order] = await pool.execute('INSERT INTO orders (user_id,order_date,total_amount,shipping_address,phone,status,note) VALUES (?,NOW(),?,?,?,?,?)', [customer.id, product.price, '123 Fixture Street', '0123456789', 'Chờ xử lý', 'UC19 synthetic history fixture']);
        await pool.execute('INSERT INTO order_details (order_id,product_id,quantity,unit_price,subtotal) VALUES (?,?,1,?,?)', [order.insertId, product.product_id, product.price, product.price]);
        await pool.execute('INSERT INTO payments (order_id,payment_method,payment_status,amount,created_at) VALUES (?,?,?,?,NOW())', [order.insertId, 'COD', 'Chưa thanh toán', product.price]);
        await pool.execute('INSERT INTO reviews (user_id,product_id,rating,comment,created_at) VALUES (?,?,5,?,NOW())', [customer.id, product.product_id, 'UC19 history fixture']);
        const history = await related(customer.id);
        assert.ok(Object.values(history).every(rows => rows.length > 0));
        const endpoints = [['/api/admin/users', 'GET'], [`/api/admin/users/${customer.id}`, 'GET'], [`/api/admin/users/${customer.id}/status`, 'PATCH', { status: 'inactive' }]];
        const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 });
        for (const [url, method, body] of endpoints) {
            assert.equal((await request(url, method, body, customer.token)).status, 403);
            for (const token of [null, 'invalid', expired]) assert.equal((await request(url, method, body, token)).status, 401);
        }
        assert.equal((await lock(accounts[2].id, 'inactive')).status, 200);
        const query = '/api/admin/users?q=' + encodeURIComponent(prefix);
        const list = await request(query);
        assert.equal(list.data.total, 2);
        assert.ok(list.data.users.every(user => user.role === 'user'));
        assert.equal((await request(query + '&status=active')).data.total, 1);
        assert.equal((await request(query + '&status=inactive')).data.total, 1);
        assert.equal((await request('/api/admin/users?q=' + encodeURIComponent(emails[1]))).data.users[0].user_id, customer.id);
        assert.equal((await request('/api/admin/users?q=' + encodeURIComponent(prefix + '_%'))).data.total, 1);
        assert.equal((await request('/api/admin/users?q=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
        const first = (await request(query + '&page=1&limit=1')).data;
        const second = (await request(query + '&page=2&limit=1')).data;
        assert.equal(first.users.length, 1);
        assert.equal(second.users.length, 1);
        assert.notEqual(first.users[0].user_id, second.users[0].user_id);
        const detail = await request(`/api/admin/users/${customer.id}`);
        assert.equal(detail.data.user.email, emails[1]);
        assert.equal(detail.data.user.phone, '0123456789');
        assert.equal((await request(`/api/admin/users/${accounts[0].id}`)).status, 404);
        assert.equal((await lock(accounts[0].id, 'inactive')).status, 404);
        assert.equal((await request('/api/admin/users/2147483647')).status, 404);
        for (const url of ['/api/admin/users?page=0', '/api/admin/users?limit=101', '/api/admin/users?status=locked', '/api/admin/users?role=admin', '/api/admin/users?q[]=x', '/api/admin/users/nope']) assert.equal((await request(url)).status, 400);
        for (const body of [{}, { status: 'locked' }, { status: 'ACTIVE' }, { status: 'inactive', role: 'admin' }, { status: 'inactive', password: 'REJECTED_TEST_INPUT' }, { role: 'admin' }, { status: null }, []]) assert.equal((await request(`/api/admin/users/${customer.id}/status`, 'PATCH', body)).status, 400);
        assert.equal((await request('/api/auth/me', 'GET', undefined, customer.token)).status, 200);
        assert.equal((await lock(customer.id, 'inactive')).status, 200);
        assert.equal((await lock(customer.id, 'inactive')).status, 200);
        const blocked = [
            ['/api/auth/me', 'GET'], ['/api/users/me', 'PUT', { full_name: 'Blocked' }],
            ['/api/cart', 'GET'], ['/api/cart/items', 'POST', { product_id: product.product_id, quantity: 1 }],
            [`/api/cart/items/${item.insertId}`, 'PUT', { quantity: 2 }], [`/api/cart/items/${item.insertId}`, 'DELETE'],
            ['/api/orders', 'GET'], ['/api/orders', 'POST', {}], [`/api/orders/${order.insertId}`, 'GET'],
            [`/api/orders/${order.insertId}/payment`, 'GET'], [`/api/orders/${order.insertId}/payment/simulate`, 'POST', { test_case: 'ONLINE_SUCCESS' }],
            ['/api/admin/users', 'GET'], ['/api/admin/orders', 'GET'], ['/api/admin/products', 'GET'], ['/api/admin/categories', 'GET']
        ];
        for (const [url, method, body] of blocked) {
            const response = await request(url, method, body, customer.token);
            assert.equal(response.status, 403);
            assert.equal(response.data.message, 'Account is inactive');
        }
        assert.equal((await request('/api/auth/login', 'POST', { email: emails[1], password: 'User-management-test-2026!' }, null)).status, 403);
        assert.deepEqual(await related(customer.id), history);
        assert.equal((await lock(customer.id, 'active')).status, 200);
        assert.equal((await request('/api/auth/me', 'GET', undefined, customer.token)).status, 200);
        assert.equal((await request('/api/cart', 'GET', undefined, customer.token)).status, 200);
        assert.equal((await request(`/api/orders/${order.insertId}`, 'GET', undefined, customer.token)).status, 200);
        assert.deepEqual(await related(customer.id), history);
        const [afterPasswords] = await pool.execute('SELECT password FROM `user` WHERE user_id IN (?, ?, ?)', accounts.map(account => account.id));
        assert.equal(afterPasswords.every((row, index) => row.password === knownHashes[index]), true);
        const [[admin]] = await pool.execute('SELECT role,status FROM `user` WHERE user_id=?', [accounts[0].id]);
        assert.deepEqual(admin, { role: 'admin', status: 'active' });
        console.log('UC19 listing/search/filter/pagination, no password responses, old-JWT lock/unlock and history retention verified.');
    } finally {
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email=?', [email]);
                if (!user) continue;
                await db.execute('DELETE p FROM payments p JOIN orders o ON o.order_id=p.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE d FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM orders WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM reviews WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id=ci.cart_id WHERE c.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM carts WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM `user` WHERE user_id=?', [user.user_id]);
            }
            await db.commit();
            if (before) {
                const after = await catalog();
                assert.equal(after.digest, before.digest);
                console.log(`UC19 cleanup verified: ${after.products.length} products / ${after.categories.length} categories unchanged, no inventory writes.`);
            }
            const [remaining] = await db.execute('SELECT user_id FROM `user` WHERE email IN (?, ?, ?)', emails);
            assert.equal(remaining.length, 0);
        } catch (error) { await db.rollback(); throw error; }
        finally {
            db.release();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
