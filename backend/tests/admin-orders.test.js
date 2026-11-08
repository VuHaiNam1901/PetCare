const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');
const { migrate, legacyNote } = require('../migrations/001-admin-orders');

test('legacy metadata parsing preserves user notes', () => {
    assert.equal(legacyNote('Plain user note'), null);
    assert.equal(legacyNote('{"v":1,"message":"Ordinary JSON note"}'), null);
    const data = { v: 1, key: 'a'.repeat(64), fingerprint: 'b'.repeat(64), note: 'Ghi chú cũ' };
    assert.deepEqual(legacyNote(JSON.stringify(data)), data);
    assert.throws(() => legacyNote(JSON.stringify({ ...data, key: 'invalid' })), /Malformed/);
});

test('admin orders: migration, access, approval, transitions, cancellation races and rollback', async () => {
    const emails = Array.from({ length: 3 }, () => `admin-orders-test-${randomUUID()}@example.com`);
    const accounts = [];
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const originalGetConnection = pool.getConnection;
    let before;
    let testBackup;
    const base = `http://127.0.0.1:${server.address().port}`;
    async function catalog() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function request(url, method = 'GET', body, token = accounts[1]?.token, key) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await res.json();
        assert.equal(JSON.stringify(data).includes('request_fingerprint'), false);
        assert.equal(JSON.stringify(data).includes('idempotency_key_hash'), false);
        return { status: res.status, data };
    }
    const approve = order => request(`/api/admin/orders/${order.order_id}/approve`, 'PATCH', {});
    const status = (order, target, extra = {}) => request(`/api/admin/orders/${order.order_id}/status`, 'PATCH', { status: target, ...extra });
    const reject = order => request(`/api/admin/orders/${order.order_id}/reject`, 'PATCH', { reason: 'Không thể tiếp nhận đơn kiểm thử.\nVui lòng liên hệ cửa hàng.' });
    const stock = async productId => (await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [productId]))[0][0].stock_quantity;
    async function create(productId, quantity = 1, method = 'COD', account = accounts[0], key = randomUUID(), concurrent = false) {
        const added = await request('/api/cart/items', 'POST', { product_id: productId, quantity }, account.token);
        assert.equal(added.status, 200);
        const body = { source: 'cart', items: [{ product_id: productId, quantity }], recipient_name: 'Admin Order Test', shipping_address: '123 Admin Test Street', phone: '0123456789', payment_method: method, note: 'Keep this note' };
        const checkout = () => request('/api/orders', 'POST', body, account.token, key);
        const results = await Promise.all(Array.from({ length: concurrent ? 4 : 1 }, checkout));
        assert.equal(results.filter(result => result.status === 201).length, 1);
        assert.ok(results.every(result => [200, 201].includes(result.status)));
        assert.ok(results.every(result => result.data.order.order_id === results[0].data.order.order_id));
        return { order: results[0].data.order, body, key };
    }
    async function removeTestBackup() {
        if (!testBackup) return;
        const root = await fs.realpath(path.join(__dirname, '..', 'backups'));
        const target = await fs.realpath(testBackup);
        if (!target.startsWith(root + path.sep) || !/^uc18-\d+-[a-f0-9-]+$/.test(path.basename(target))) throw new Error('Unsafe test backup cleanup path');
        await fs.rm(target, { recursive: true });
        testBackup = undefined;
    }
    try {
        before = await catalog();
        const products = before.products.filter(product => product.status === 'Đang bán' && product.stock_quantity >= 20);
        assert.ok(products.length >= 2);
        for (const email of emails) {
            const registered = await request('/api/auth/register', 'POST', { full_name: 'Admin Order Test', email, password: 'Admin-test-2026!' }, null);
            assert.equal(registered.status, 201);
            const login = await request('/api/auth/login', 'POST', { email, password: 'Admin-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: registered.data.user.user_id, token: login.data.token });
        }
        // Elevate only this temporary fixture, never create a default admin.
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', accounts[1].id]);
        const { order: cod, body: codBody, key } = await create(products[0].product_id, 2, 'COD', accounts[0], randomUUID(), true);
        const { order: online } = await create(products[1].product_id, 2, 'ONLINE');
        assert.equal(cod.approved_at, null);
        assert.equal(online.approved_at, null);
        const [[stored]] = await pool.execute('SELECT note, idempotency_key_hash, request_fingerprint FROM orders WHERE order_id = ?', [cod.order_id]);
        assert.equal(stored.note, codBody.note);
        assert.match(stored.idempotency_key_hash, /^[a-f0-9]{64}$/);
        // Reproduce the old note representation, run the resumable backfill,
        // verify the full backup checksum and replay the pre-migration request.
        await pool.execute('UPDATE orders SET note = ?, idempotency_key_hash = NULL, request_fingerprint = NULL WHERE order_id = ?', [JSON.stringify({ v: 1, key: stored.idempotency_key_hash, fingerprint: stored.request_fingerprint, note: stored.note }), cod.order_id]);
        const migrated = await migrate(pool);
        testBackup = migrated.backupDirectory;
        assert.equal(migrated.migratedNotes, 1);
        const manifest = JSON.parse(await fs.readFile(path.join(testBackup, 'manifest.json'), 'utf8'));
        assert.equal(createHash('sha256').update(await fs.readFile(path.join(testBackup, 'database.sql'))).digest('hex'), manifest.sql_sha256);
        assert.equal((await request('/api/orders', 'POST', codBody, accounts[0].token, key)).data.order.order_id, cod.order_id);
        assert.equal((await request('/api/orders', 'POST', { ...codBody, phone: '0987654321' }, accounts[0].token, key)).status, 409);
        await removeTestBackup();
        // The database UNIQUE itself rejects a collision for the same buyer.
        await assert.rejects(pool.execute('UPDATE orders SET idempotency_key_hash = ? WHERE order_id = ?', [stored.idempotency_key_hash, online.order_id]), { code: 'ER_DUP_ENTRY' });
        // The same key is allowed for a different buyer.
        const { order: other } = await create(products[0].product_id, 1, 'COD', accounts[2], key);
        assert.notEqual(other.order_id, cod.order_id);
        const endpoints = [['/api/admin/orders', 'GET'], [`/api/admin/orders/${cod.order_id}`, 'GET'], [`/api/admin/orders/${cod.order_id}/approve`, 'PATCH', {}], [`/api/admin/orders/${cod.order_id}/status`, 'PATCH', { status: 'Đã hủy' }]];
        const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[1].id), expiresIn: -1 });
        for (const [url, method, body] of endpoints) {
            for (const token of [null, 'invalid', expired]) assert.equal((await request(url, method, body, token)).status, 401);
            assert.equal((await request(url, method, body, accounts[0].token)).status, 403);
        }
        assert.equal((await request('/api/admin/orders?page=1&limit=1')).data.orders.length, 1);
        const filtered = await request('/api/admin/orders?status=' + encodeURIComponent('Chờ thanh toán'));
        assert.equal(filtered.status, 200);
        assert.ok(filtered.data.orders.some(order => order.order_id === online.order_id));
        assert.ok(filtered.data.orders.every(order => order.status === 'Chờ thanh toán'));
        assert.equal((await request(`/api/admin/orders/${cod.order_id}`)).data.order.items.length, 1);
        assert.equal((await request('/api/admin/orders?status=invalid')).status, 400);
        assert.equal((await request('/api/admin/orders?page=0')).status, 400);
        assert.equal((await request('/api/admin/orders/2147483647')).status, 404);
        assert.equal((await request(`/api/admin/orders/${cod.order_id}/approve`, 'PATCH', { payment_status: 'Đã thanh toán' })).status, 400);
        assert.equal((await status(cod, 'Đã giao hàng', { cod_payment_received: true })).status, 409);
        assert.equal((await status(online, 'Chờ giao hàng')).status, 409);
        const approvals = await Promise.all([approve(cod), approve(cod)]);
        assert.ok(approvals.every(result => result.status === 200));
        assert.equal(approvals[0].data.order.approved_at, approvals[1].data.order.approved_at);
        assert.equal(approvals[0].data.order.status, 'Chờ giao hàng');
        assert.equal(approvals[0].data.order.payment_status, 'Chưa thanh toán');
        assert.equal((await status(cod, 'Đã giao hàng', { cod_payment_received: true })).status, 409);
        assert.equal((await status(cod, 'Đang giao hàng')).status, 200);
        assert.equal((await status(cod, 'Đã hủy')).status, 409);
        assert.equal((await status(cod, 'Đã giao hàng')).status, 409);
        const delivered = await status(cod, 'Đã giao hàng', { cod_payment_received: true });
        assert.equal(delivered.status, 200);
        assert.equal(delivered.data.order.payment_status, 'Đã thanh toán');
        assert.ok(delivered.data.order.transaction_date);
        assert.equal((await status(cod, 'Đã hủy')).status, 409);
        assert.equal((await approve(cod)).status, 409);
        const approvedOnline = await approve(online);
        assert.equal(approvedOnline.status, 200);
        assert.ok(approvedOnline.data.order.approved_at);
        assert.equal(approvedOnline.data.order.status, 'Chờ thanh toán');
        assert.equal(approvedOnline.data.order.payment_status, 'Chưa thanh toán');
        assert.equal((await status(online, 'Chờ giao hàng')).status, 409);
        assert.equal((await status(online, 'Đang giao hàng')).status, 409);
        assert.equal((await status(online, 'Đã giao hàng', { cod_payment_received: true })).status, 409);
        assert.ok((await request(`/api/orders/${online.order_id}`, 'GET', undefined, accounts[0].token)).data.order.approved_at);

        const beforeRace = await stock(products[0].product_id);
        const { order: race } = await create(products[0].product_id, 3);
        const raced = await Promise.all([approve(race), reject(race), reject(race)]);
        assert.ok(raced.every(result => [200, 409].includes(result.status)));
        const raceResult = (await request(`/api/admin/orders/${race.order_id}`)).data.order;
        if (raceResult.status === 'Đã hủy') {
            assert.equal(raced[0].status, 409);
            assert.equal(raced[1].status, 200);
            assert.equal(raced[2].status, 200);
            assert.equal(await stock(products[0].product_id), beforeRace);
        } else {
            assert.equal(raced[0].status, 200);
            assert.equal(raced[1].status, 409);
            assert.equal(raced[2].status, 409);
            assert.equal(await stock(products[0].product_id), beforeRace - 3);
        }
        const { order: rejectedOrder } = await create(products[0].product_id, 2);
        const beforeReject = await stock(products[0].product_id);
        assert.equal((await reject(rejectedOrder)).status, 200);
        const cancelled = (await request(`/api/admin/orders/${rejectedOrder.order_id}`)).data.order;
        assert.equal(cancelled.status, 'Đã hủy');
        assert.equal(cancelled.payment_status, 'Đã hủy');
        assert.ok(cancelled.stock_restored_at);
        await reject(rejectedOrder);
        assert.equal(await stock(products[0].product_id), beforeReject + 2);
        assert.equal((await approve(rejectedOrder)).status, 409);
        assert.equal((await reject(online)).status, 409);

        // Inject a payment-update failure after a real cancellation stock update.
        const { order: rollbackOrder } = await create(products[1].product_id, 1, 'ONLINE');
        const beforeRollback = await stock(products[1].product_id);
        pool.getConnection = async function () {
            const db = await originalGetConnection.call(pool);
            const execute = db.execute.bind(db);
            const release = db.release.bind(db);
            db.execute = (sql, params) => {
                if (sql.startsWith('UPDATE payments SET payment_status')) throw new Error('Simulated cancellation failure');
                return execute(sql, params);
            };
            db.release = () => { db.execute = execute; db.release = release; release(); };
            return db;
        };
        try { assert.equal((await reject(rollbackOrder)).status, 500); }
        finally { pool.getConnection = originalGetConnection; }
        assert.equal(await stock(products[1].product_id), beforeRollback);
        const rolledBack = (await request(`/api/admin/orders/${rollbackOrder.order_id}`)).data.order;
        assert.equal(rolledBack.status, 'Chờ thanh toán');
        assert.equal(rolledBack.stock_restored_at, null);
        assert.equal(rolledBack.payment_status, 'Chưa thanh toán');
        assert.equal((await reject(rollbackOrder)).status, 200);

        // Test-only paid ONLINE fixture; no payment API or simulated payment is added.
        const { order: paidOnline } = await create(products[1].product_id, 1, 'ONLINE');
        assert.equal((await approve(paidOnline)).status, 200);
        await pool.execute('UPDATE payments SET payment_status = ?, transaction_date = NOW() WHERE order_id = ?', ['Đã thanh toán', paidOnline.order_id]);
        await pool.execute('UPDATE orders SET status = ? WHERE order_id = ?', ['Chờ giao hàng', paidOnline.order_id]);
        assert.equal((await status(paidOnline, 'Đã hủy')).status, 409);
        assert.equal((await status(paidOnline, 'Chờ giao hàng')).status, 200);
        assert.equal((await status(paidOnline, 'Đang giao hàng')).status, 200);
        assert.equal((await status(paidOnline, 'Đã giao hàng')).status, 200);
        console.log('Admin guards, migration/backfill/replay, UNIQUE scope, concurrent approval/cancellation, one-time stock restoration and rollback verified.');
    } finally {
        pool.getConnection = originalGetConnection;
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email = ?', [email]);
                if (!user) continue;
                const [quantities] = await db.execute('SELECT d.product_id, SUM(d.quantity) AS quantity FROM order_details d JOIN orders o ON o.order_id = d.order_id WHERE o.user_id = ? AND o.stock_restored_at IS NULL GROUP BY d.product_id', [user.user_id]);
                for (const row of quantities) await db.execute('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ?', [Number(row.quantity), row.product_id]);
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
                console.log(`Admin test cleanup verified: ${after.products.length} products / ${after.categories.length} categories identical.`);
            }
            const [leftovers] = await db.execute('SELECT user_id FROM `user` WHERE email IN (?, ?, ?)', emails);
            assert.equal(leftovers.length, 0);
        } catch (error) { await db.rollback(); throw error; }
        finally {
            db.release();
            await removeTestBackup();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
