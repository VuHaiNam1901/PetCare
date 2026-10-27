const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

test('orders: partial checkout, payments, durable replay, rollback, history and isolation', async () => {
    const emails = [0, 1].map(() => `orders-test-${randomUUID()}@example.com`);
    const accounts = [];
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const originalGetConnection = pool.getConnection;
    let before;
    async function catalog() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function request(path, method = 'GET', body, key, token = accounts[0]?.token) {
        const response = await fetch(base + path, { method, headers: {
            'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {})
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        assert.equal(JSON.stringify(data).includes('fingerprint'), false);
        return { status: response.status, data };
    }
    const add = async (productId, quantity = 1, token = accounts[0].token) => {
        const result = await request('/api/cart/items', 'POST', { product_id: productId, quantity }, undefined, token);
        assert.equal(result.status, 200);
        return result.data.cart.items.find(item => item.product_id === productId).cart_item_id;
    };
    // Intercept only this test process's connection to inject failures without
    // changing product statuses or database schema. All writes remain real SQL.
    async function injected(interceptor, action) {
        pool.getConnection = async function () {
            const db = await originalGetConnection.call(pool);
            const execute = db.execute.bind(db);
            db.execute = (sql, params) => interceptor(sql, params, execute);
            const release = db.release.bind(db);
            db.release = () => { db.execute = execute; db.release = release; release(); };
            return db;
        };
        try { return await action(); }
        finally { pool.getConnection = originalGetConnection; }
    }
    try {
        before = await catalog();
        const products = before.products.filter(p => p.status === 'Đang bán' && p.stock_quantity >= 10);
        assert.ok(products.length >= 2);
        for (const email of emails) {
            const registered = await request('/api/auth/register', 'POST', { full_name: 'Order Test', email, password: 'Order-test-2026!' }, undefined, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email, password: 'Order-test-2026!' }, undefined, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        const first = await add(products[0].product_id);
        const second = await add(products[1].product_id, 2);
        const payload = { cart_item_ids: [first], shipping_address: '123 Test Street', phone: '+84123456789', payment_method: 'COD', note: 'Test delivery' };
        for (const token of [null, 'bad', jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 })]) {
            for (const [path, method, body] of [['/api/orders', 'POST', payload], ['/api/orders', 'GET'], ['/api/orders/1', 'GET']]) assert.equal((await request(path, method, body, randomUUID(), token)).status, 401);
        }
        for (const changes of [{ shipping_address: '' }, { phone: '------' }, { payment_method: 'CASH' }, { user_id: accounts[1].id }, { total_amount: 1 }, { status: 'paid' }, { cart_item_ids: [] }, { cart_item_ids: [first, first] }, { cart_item_ids: ['1'] }]) {
            assert.equal((await request('/api/orders', 'POST', { ...payload, ...changes }, randomUUID())).status, 400);
        }
        assert.equal((await request('/api/orders', 'POST', payload)).status, 400);
        const key = randomUUID();
        const responses = await Promise.all(Array.from({ length: 4 }, () => request('/api/orders', 'POST', payload, key)));
        assert.equal(responses.filter(r => r.status === 201).length, 1);
        assert.equal(responses.filter(r => r.status === 200).length, 3);
        const order = responses[0].data.order;
        assert.ok(responses.every(r => r.data.order.order_id === order.order_id));
        assert.equal(order.status, 'Chờ xử lý');
        assert.equal(order.payment_status, 'Chưa thanh toán');
        assert.equal(order.payment_method, 'COD');
        assert.equal(order.transaction_date, null);
        assert.equal(order.note, payload.note);
        assert.equal(order.recipient_name, 'Order Test');
        assert.equal(order.total_amount, products[0].price);
        assert.equal(order.items[0].unit_price, products[0].price);
        assert.equal((await request('/api/cart')).data.cart.items[0].cart_item_id, second);
        assert.equal((await request('/api/cart')).data.cart.items.length, 1);
        assert.equal((await request('/api/orders', 'POST', payload, key)).status, 200);
        assert.equal((await request('/api/orders', 'POST', { ...payload, phone: '0123456789' }, key)).status, 409);
        assert.equal((await request('/api/orders', 'POST', payload, randomUUID())).status, 409);
        assert.equal((await request(`/api/orders/${order.order_id}`, 'GET', undefined, undefined, accounts[1].token)).status, 404);
        assert.equal((await request('/api/orders', 'GET', undefined, undefined, accounts[1].token)).data.total, 0);
        assert.equal((await request('/api/orders', 'POST', { ...payload, cart_item_ids: [second] }, randomUUID(), accounts[1].token)).status, 409);

        // Inject failure after header, details and stock updates, at payment insert.
        const [[stockBefore]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [products[1].product_id]);
        const online = { ...payload, cart_item_ids: [second], payment_method: 'ONLINE' };
        const rollbackKey = randomUUID();
        const failed = await injected(async (sql, params, execute) => {
            if (sql.startsWith('INSERT INTO payments')) throw new Error('Simulated payment storage failure');
            return execute(sql, params);
        }, () => request('/api/orders', 'POST', online, rollbackKey));
        assert.equal(failed.status, 500);
        assert.equal((await request('/api/orders')).data.total, 1);
        assert.equal((await request('/api/cart')).data.cart.items[0].cart_item_id, second);
        const [[stockAfter]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [products[1].product_id]);
        assert.deepEqual(stockAfter, stockBefore);
        for (const change of [{ status: 'Ngừng bán' }, { stock_quantity: 0 }]) {
            const result = await injected(async (sql, params, execute) => {
                const result = await execute(sql, params);
                if (sql.startsWith('SELECT product_id, price, status, stock_quantity')) Object.assign(result[0][0], change);
                return result;
            }, () => request('/api/orders', 'POST', online, randomUUID()));
            assert.equal(result.status, 409);
        }
        const onlineOrder = await request('/api/orders', 'POST', online, rollbackKey);
        assert.equal(onlineOrder.status, 201);
        assert.equal(onlineOrder.data.order.status, 'Chờ thanh toán');
        assert.equal(onlineOrder.data.order.payment_status, 'Chưa thanh toán');
        assert.equal(onlineOrder.data.order.total_amount, (Number(products[1].price) * 2).toFixed(2));

        const items = [await add(products[0].product_id), await add(products[1].product_id)];
        const multi = await request('/api/orders', 'POST', { ...payload, cart_item_ids: items }, randomUUID());
        assert.equal(multi.status, 201);
        assert.equal(multi.data.order.items.length, 2);
        assert.equal((await request('/api/cart')).data.cart.items.length, 0);
        const history = await request('/api/orders?page=1&limit=2');
        assert.equal(history.data.total, 3);
        assert.equal(history.data.orders.length, 2);
        assert.ok(history.data.orders.every(o => o.items.length > 0));
        assert.equal((await request(`/api/orders/${order.order_id}`)).data.order.order_id, order.order_id);
        assert.equal((await request('/api/orders?user_id=1')).status, 400);
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[1].id]);
        assert.equal((await request('/api/orders', 'GET', undefined, undefined, accounts[1].token)).status, 403);
        assert.equal((await request('/api/orders', 'POST', payload, randomUUID(), accounts[1].token)).status, 403);
        assert.equal((await request(`/api/orders/${order.order_id}`, 'GET', undefined, undefined, accounts[1].token)).status, 403);
        const [payments] = await pool.execute('SELECT p.* FROM payments p JOIN orders o ON o.order_id = p.order_id WHERE o.user_id = ?', [accounts[0].id]);
        assert.equal(payments.length, 3);
        assert.ok(payments.every(p => p.payment_status === 'Chưa thanh toán' && p.transaction_date === null));
        console.log('Real MySQL rollback verified after stock/detail writes; unavailable/stock rejection exercised using test-only read injection.');
    } finally {
        pool.getConnection = originalGetConnection;
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email = ?', [email]);
                if (!user) continue;
                const [stock] = await db.execute('SELECT d.product_id, SUM(d.quantity) AS quantity FROM order_details d JOIN orders o ON o.order_id = d.order_id WHERE o.user_id = ? GROUP BY d.product_id', [user.user_id]);
                for (const item of stock) await db.execute('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ?', [Number(item.quantity), item.product_id]);
                await db.execute('DELETE p FROM payments p JOIN orders o ON o.order_id = p.order_id WHERE o.user_id = ?', [user.user_id]);
                await db.execute('DELETE d FROM order_details d JOIN orders o ON o.order_id = d.order_id WHERE o.user_id = ?', [user.user_id]);
                await db.execute('DELETE FROM orders WHERE user_id = ?', [user.user_id]);
                await db.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id = ci.cart_id WHERE c.user_id = ?', [user.user_id]);
                await db.execute('DELETE FROM carts WHERE user_id = ?', [user.user_id]);
                await db.execute('DELETE FROM `user` WHERE user_id = ?', [user.user_id]);
            }
            await db.commit();
            if (before) {
                const after = await catalog();
                assert.equal(after.hash, before.hash);
                console.log(`Cleanup verified: ${after.products.length} products and ${after.categories.length} categories identical, stock restored.`);
            }
            const [remaining] = await db.execute('SELECT user_id FROM `user` WHERE email IN (?, ?)', emails);
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
