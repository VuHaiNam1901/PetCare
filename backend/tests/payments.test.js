const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

test('simulated payment: approval, retry, concurrency, ownership, rollback and UC18 integration', async () => {
    const emails = Array.from({ length: 3 }, () => `payment-test-${randomUUID()}@example.com`);
    const accounts = [];
    const originalGetConnection = pool.getConnection;
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let before;
    async function catalog() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function request(url, method = 'GET', body, token = accounts[0]?.token, key) {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }
    const paymentInfo = (order, token = accounts[0].token) => request(`/api/orders/${order.order_id}/payment`, 'GET', undefined, token);
    const simulate = (order, testCase = 'ONLINE_SUCCESS', token = accounts[0].token) => request(`/api/orders/${order.order_id}/payment/simulate`, 'POST', { test_case: testCase }, token);
    const approve = order => request(`/api/admin/orders/${order.order_id}/approve`, 'PATCH', {}, accounts[1].token);
    const status = (order, target, extra = {}) => request(`/api/admin/orders/${order.order_id}/status`, 'PATCH', { status: target, ...extra }, accounts[1].token);
    async function create(productId, method = 'ONLINE') {
        const cart = await request('/api/cart/items', 'POST', { product_id: productId, quantity: 1 });
        assert.equal(cart.status, 200);
        const id = cart.data.cart.items.find(item => item.product_id === productId).cart_item_id;
        const response = await request('/api/orders', 'POST', { cart_item_ids: [id], shipping_address: '123 Simulation Test Street', phone: '0123456789', payment_method: method }, accounts[0].token, randomUUID());
        assert.equal(response.status, 201);
        return response.data.order;
    }
    async function injectOrderUpdateFailure(action) {
        pool.getConnection = async function () {
            const db = await originalGetConnection.call(pool);
            const execute = db.execute.bind(db);
            const release = db.release.bind(db);
            db.execute = (sql, params) => {
                if (sql.startsWith('UPDATE orders SET status = ? WHERE order_id = ?')) throw new Error('Simulated failure after payment write');
                return execute(sql, params);
            };
            db.release = () => { db.execute = execute; db.release = release; release(); };
            return db;
        };
        try { return await action(); }
        finally { pool.getConnection = originalGetConnection; }
    }
    try {
        before = await catalog();
        const product = before.products.find(row => row.status === 'Đang bán' && row.stock_quantity >= 20);
        assert.ok(product);
        for (const email of emails) {
            const registered = await request('/api/auth/register', 'POST', { full_name: 'Payment Test', email, password: 'Payment-test-2026!' }, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email, password: 'Payment-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[1].id]);
        const online = await create(product.product_id);
        assert.equal((await paymentInfo(online)).data.payment.can_simulate, false);
        assert.equal((await simulate(online)).status, 409);
        for (const token of [null, 'invalid', jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 })]) {
            assert.equal((await paymentInfo(online, token)).status, 401);
            assert.equal((await simulate(online, 'ONLINE_SUCCESS', token)).status, 401);
        }
        assert.equal((await paymentInfo(online, accounts[2].token)).status, 404);
        assert.equal((await simulate(online, 'ONLINE_SUCCESS', accounts[2].token)).status, 404);
        assert.equal((await paymentInfo(online, accounts[1].token)).status, 403);
        assert.equal((await simulate(online, 'ONLINE_SUCCESS', accounts[1].token)).status, 403);
        assert.equal((await request('/api/orders/2147483647/payment')).status, 404);
        assert.equal((await request('/api/orders/bad/payment')).status, 400);
        assert.equal((await request(`/api/orders/${online.order_id}/payment?user_id=1`)).status, 400);
        for (const body of [{}, { test_case: 'OTHER' }, { test_case: 'ONLINE_SUCCESS', amount: 1 }, { test_case: 'ONLINE_SUCCESS', payment_status: 'Đã thanh toán' }, { test_case: 'ONLINE_SUCCESS', order_status: 'Đã giao hàng' }, { test_case: 'ONLINE_SUCCESS', user_id: accounts[0].id }, { test_case: 'ONLINE_SUCCESS', card: 'TEST_ONLY' }, { test_case: 'ONLINE_SUCCESS', otp: 'TEST_ONLY' }]) {
            assert.equal((await request(`/api/orders/${online.order_id}/payment/simulate`, 'POST', body)).status, 400);
        }
        const cod = await create(product.product_id, 'COD');
        assert.equal((await paymentInfo(cod)).status, 200);
        assert.equal((await paymentInfo(cod)).data.payment.can_simulate, false);
        assert.equal((await simulate(cod)).status, 409);
        assert.equal((await approve(cod)).status, 200);
        assert.equal((await simulate(cod)).status, 409);
        assert.equal((await approve(online)).status, 200);
        const approvedInfo = (await paymentInfo(online)).data.payment;
        assert.equal(approvedInfo.can_simulate, true);
        assert.equal(approvedInfo.amount, online.total_amount);
        const beforePaymentCatalog = await catalog();
        const successes = await Promise.all(Array.from({ length: 5 }, () => simulate(online)));
        assert.equal(successes.filter(result => result.status === 200).length, 1);
        assert.equal(successes.filter(result => result.status === 409).length, 4);
        const paid = successes.find(result => result.status === 200).data;
        assert.equal(paid.outcome, 'success');
        assert.equal(paid.payment.payment_status, 'Đã thanh toán');
        assert.equal(paid.payment.order_status, 'Chờ giao hàng');
        assert.ok(paid.payment.transaction_date);
        assert.equal((await simulate(online)).status, 409);
        assert.equal((await simulate(online, 'ONLINE_FAILURE')).status, 409);
        assert.equal((await paymentInfo(online)).data.payment.transaction_date, paid.payment.transaction_date);
        assert.equal((await catalog()).hash, beforePaymentCatalog.hash, 'Payment must never touch stock/catalog');
        assert.equal((await status(online, 'Đã hủy')).status, 409);
        assert.equal((await status(online, 'Đang giao hàng')).status, 200);
        assert.equal((await status(online, 'Đã giao hàng')).status, 200);
        assert.equal((await simulate(online)).status, 409);

        const retry = await create(product.product_id);
        assert.equal((await approve(retry)).status, 200);
        const failed = await simulate(retry, 'ONLINE_FAILURE');
        assert.equal(failed.status, 200);
        assert.equal(failed.data.outcome, 'failure');
        assert.equal(failed.data.payment.payment_status, 'Thất bại');
        assert.equal(failed.data.payment.order_status, 'Chờ thanh toán');
        assert.equal(failed.data.payment.transaction_date, null);
        assert.equal(failed.data.payment.can_simulate, true);
        assert.equal((await status(retry, 'Chờ giao hàng')).status, 409);
        assert.equal((await approve(retry)).status, 200);
        assert.equal((await simulate(retry)).data.payment.payment_status, 'Đã thanh toán');

        const rollbackOrder = await create(product.product_id);
        assert.equal((await approve(rollbackOrder)).status, 200);
        const originalInfo = (await paymentInfo(rollbackOrder)).data;
        for (const testCase of ['ONLINE_SUCCESS', 'ONLINE_FAILURE']) {
            assert.equal((await injectOrderUpdateFailure(() => simulate(rollbackOrder, testCase))).status, 500);
            assert.deepEqual((await paymentInfo(rollbackOrder)).data, originalInfo);
        }
        assert.equal((await simulate(rollbackOrder)).status, 200);

        const cancelFailed = await create(product.product_id);
        assert.equal((await approve(cancelFailed)).status, 200);
        assert.equal((await simulate(cancelFailed, 'ONLINE_FAILURE')).status, 200);
        assert.equal((await status(cancelFailed, 'Đã hủy')).status, 200);
        assert.equal((await paymentInfo(cancelFailed)).data.payment.payment_status, 'Đã hủy');
        assert.equal((await simulate(cancelFailed)).status, 409);
        // UC18 and UC15 share the same order/payment lock protocol.
        const racedOrder = await create(product.product_id);
        assert.equal((await approve(racedOrder)).status, 200);
        const raced = await Promise.all([simulate(racedOrder), status(racedOrder, 'Đã hủy')]);
        assert.equal(raced.filter(result => result.status === 200).length, 1);
        assert.equal(raced.filter(result => result.status === 409).length, 1);
        const racedInfo = (await paymentInfo(racedOrder)).data.payment;
        assert.ok((racedInfo.payment_status === 'Đã thanh toán' && racedInfo.order_status === 'Chờ giao hàng') || (racedInfo.payment_status === 'Đã hủy' && racedInfo.order_status === 'Đã hủy'));
        // COD still requires explicit cash confirmation on delivery.
        assert.equal((await status(cod, 'Đang giao hàng')).status, 200);
        assert.equal((await status(cod, 'Đã giao hàng')).status, 409);
        assert.equal((await status(cod, 'Đã giao hàng', { cod_payment_received: true })).data.order.payment_status, 'Đã thanh toán');
        const detail = await request(`/api/orders/${retry.order_id}`);
        assert.equal(detail.data.order.payment_status, 'Đã thanh toán');
        assert.equal(detail.data.order.status, 'Chờ giao hàng');
        console.log('Payment concurrency, retry, failed-payment cancellation, COD regression and real SQL rollback verified.');
    } finally {
        pool.getConnection = originalGetConnection;
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email = ?', [email]);
                if (!user) continue;
                const [quantities] = await db.execute('SELECT d.product_id, SUM(d.quantity) AS quantity FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=? AND o.stock_restored_at IS NULL GROUP BY d.product_id', [user.user_id]);
                for (const row of quantities) await db.execute('UPDATE products SET stock_quantity=stock_quantity+? WHERE product_id=?', [Number(row.quantity), row.product_id]);
                await db.execute('DELETE p FROM payments p JOIN orders o ON o.order_id=p.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE d FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM orders WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE ci FROM cart_items ci JOIN carts c ON c.cart_id=ci.cart_id WHERE c.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM carts WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM `user` WHERE user_id=?', [user.user_id]);
            }
            await db.commit();
            if (before) {
                const after = await catalog();
                assert.equal(after.hash, before.hash);
                console.log(`Payment cleanup verified: ${after.products.length} products / ${after.categories.length} categories unchanged, stock restored.`);
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
