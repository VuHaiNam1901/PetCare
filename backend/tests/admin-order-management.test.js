const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

let server, base, adminA, adminB, customer, stranger, categoryId;
const passwords = 'Synthetic-account-not-used-for-login';

async function account(role) {
    const [created] = await pool.execute(`INSERT INTO \`user\`
        (full_name,email,password,role,status,created_at) VALUES (?,?,?,?,'active',NOW())`,
    ['Nguyễn Kiểm Thử ' + role, `admin-workflow-${randomUUID()}@example.test`, passwords, role]);
    return { id: created.insertId, token: jwt.sign({}, process.env.JWT_SECRET, { subject: String(created.insertId), expiresIn: 3600 }) };
}

async function request(path, { method = 'GET', body, token = adminA?.token, key } = {}) {
    const response = await fetch(base + path, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
}
const detail = order => request(`/api/admin/orders/${order.order_id}`);
const approve = (order, token) => request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', body: {}, ...(token ? { token } : {}) });
const reject = (order, reason = 'Cửa hàng chưa thể tiếp nhận.\nVui lòng liên hệ 🐾.', token) => request(`/api/admin/orders/${order.order_id}/reject`, { method: 'PATCH', body: { reason }, ...(token ? { token } : {}) });
const update = (order, status, extra = {}, token) => request(`/api/admin/orders/${order.order_id}/status`, { method: 'PATCH', body: { status, ...extra }, ...(token ? { token } : {}) });
const stock = async id => (await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [id]))[0][0].stock_quantity;

async function product(quantity = 20, name = 'Hàng riêng kiểm thử Admin') {
    const [created] = await pool.execute(`INSERT INTO products
        (category_id,name,description,price,stock_quantity,image_url,status,created_at) VALUES (?,?,?,'1000.25',?,?,'Đang bán',NOW())`,
    [categoryId, name, 'Synthetic fixture in disposable database only', quantity, '/images/test-admin.webp']);
    return created.insertId;
}

async function createOrder({ method = 'COD', quantity = 2, productId, products, phone = '0991112233' } = {}) {
    const id = productId || await product();
    const items = products || [{ product_id: id, quantity }];
    if (items.length > 1) {
        await pool.execute('INSERT IGNORE INTO carts (user_id,created_at) VALUES (?,NOW())', [customer.id]);
        const [[cart]] = await pool.execute('SELECT cart_id FROM carts WHERE user_id = ?', [customer.id]);
        for (const item of items) await pool.execute('INSERT INTO cart_items (cart_id,product_id,quantity,selected,created_at) VALUES (?,?,?,1,NOW()) ON DUPLICATE KEY UPDATE quantity=VALUES(quantity)', [cart.cart_id, item.product_id, item.quantity]);
    }
    const response = await request('/api/orders', { method: 'POST', token: customer.token, key: randomUUID(), body: {
        source: items.length > 1 ? 'cart' : 'buy-now', items, recipient_name: 'Nguyễn Thị Ánh 🐾',
        shipping_address: 'Căn hộ 1208, đường Nguyễn Văn Cừ\nThành phố Hồ Chí Minh', phone,
        payment_method: method, note: 'Gọi trước khi giao.\nGiữ đúng Unicode.' } });
    return { ...response, productId: id };
}

async function injectFailure(match, action) {
    const original = pool.getConnection;
    pool.getConnection = async function () {
        const db = await original.call(pool), execute = db.execute.bind(db), release = db.release.bind(db);
        db.execute = (sql, params) => { if (match(sql)) throw new Error('Injected transaction failure'); return execute(sql, params); };
        db.release = () => { db.execute = execute; db.release = release; release(); };
        return db;
    };
    try { return await action(); }
    finally { pool.getConnection = original; }
}

before(async () => {
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.notEqual(process.env.DB_NAME, process.env.PETCARE_TEST_SOURCE_DATABASE);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    adminA = await account('admin'); adminB = await account('admin');
    customer = await account('user'); stranger = await account('user');
    const [created] = await pool.execute('INSERT INTO categories (name,description,created_at) VALUES (?,?,NOW())', ['Admin test category', 'Disposable fixture']);
    categoryId = created.insertId;
});

after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
});

test('all Admin reads and writes enforce current backend role, JWT and active account', async () => {
    const created = await createOrder(); assert.equal(created.status, 201);
    const order = created.data.order;
    const endpoints = [
        ['/api/admin/orders', 'GET'], [`/api/admin/orders/${order.order_id}`, 'GET'],
        [`/api/admin/orders/${order.order_id}/approve`, 'PATCH', {}],
        [`/api/admin/orders/${order.order_id}/reject`, 'PATCH', { reason: 'Test' }],
        [`/api/admin/orders/${order.order_id}/status`, 'PATCH', { status: 'Đang giao hàng' }],
    ];
    for (const [path, method, body] of endpoints) {
        for (const token of [null, 'invalid', jwt.sign({}, process.env.JWT_SECRET, { subject: String(adminA.id), expiresIn: -1 })]) assert.equal((await request(path, { method, body, token })).status, 401);
        assert.equal((await request(path, { method, body, token: customer.token })).status, 403);
    }
    await pool.execute("UPDATE `user` SET role='user' WHERE user_id=?", [adminB.id]);
    assert.equal((await approve(order, adminB.token)).status, 403, 'Role claims must not override current database role');
    await pool.execute("UPDATE `user` SET role='admin',status='inactive' WHERE user_id=?", [adminB.id]);
    assert.equal((await approve(order, adminB.token)).status, 403);
    await pool.execute("UPDATE `user` SET status='active' WHERE user_id=?", [adminB.id]);
});

test('Checkout creates a durable reservation and real creation history for COD and Online pending approval', async () => {
    for (const method of ['COD', 'ONLINE']) {
        const id = await product(4);
        const created = await createOrder({ method, productId: id, quantity: 4 });
        assert.equal(created.status, 201);
        const order = created.data.order;
        assert.equal(await stock(id), 0);
        assert.ok(order.stock_reserved_at);
        assert.equal(order.stock_reservation_source, 'checkout-v5');
        assert.equal(order.approval_state, 'pending');
        assert.deepEqual(order.allowed_actions, ['approve', 'reject']);
        assert.equal(order.payment_status, 'Chưa thanh toán');
        assert.equal(order.history.length, 1);
        assert.equal(order.history[0].action, 'created');
        assert.equal(order.history[0].from_status, null);
        assert.equal(order.history[0].to_status, order.status);
        assert.equal(order.history[0].actor_id, customer.id);
        assert.equal((await approve(order)).status, 200, 'Already reserved stock may leave zero freely available units');
        assert.equal(await stock(id), 0, 'Approval must never deduct reserved stock again');
    }
});

test('Admin list supports literal order ID/phone search, pagination and combined status/approval filters', async () => {
    const created = await createOrder({ phone: '0988776655' }); assert.equal(created.status, 201);
    const order = created.data.order;
    const byId = await request(`/api/admin/orders?q=%23${order.order_id}&limit=1&page=1`);
    assert.equal(byId.status, 200); assert.equal(byId.data.total, 1);
    assert.equal(byId.data.orders[0].order_id, order.order_id);
    const byPhone = await request('/api/admin/orders?q=09887766&approval=pending&status=' + encodeURIComponent('Chờ xử lý'));
    assert.equal(byPhone.status, 200); assert.ok(byPhone.data.orders.some(row => row.order_id === order.order_id));
    assert.ok(byPhone.data.orders.every(row => row.approval_state === 'pending' && row.status === 'Chờ xử lý'));
    assert.equal((await request('/api/admin/orders?q=%25')).data.total, 0, 'Percent is a literal, not a LIKE wildcard');
    assert.equal((await request('/api/admin/orders?q=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
    for (const query of ['page=0', 'limit=101', 'q[]=a', 'approval=other', 'status=other', 'user_id=1']) assert.equal((await request('/api/admin/orders?' + query)).status, 400);
    assert.equal((await request('/api/admin/orders/2147483647')).status, 404);
});

test('COD approval and delivery serialize duplicate Admin requests and cash collection commits atomically', async () => {
    const created = await createOrder(); assert.equal(created.status, 201);
    const order = created.data.order, reserved = await stock(created.productId);
    const approvals = await Promise.all(Array.from({ length: 6 }, (_, index) => approve(order, index % 2 ? adminA.token : adminB.token)));
    assert.ok(approvals.every(result => result.status === 200));
    const approved = (await detail(order)).data.order;
    assert.equal(approved.status, 'Chờ giao hàng'); assert.equal(approved.approval_state, 'approved');
    assert.equal(approved.history.filter(row => row.action === 'approve').length, 1);
    assert.equal(await stock(created.productId), reserved);
    assert.equal((await reject(order)).status, 409);
    assert.equal((await update(order, 'Đã giao hàng', { cod_payment_received: true })).status, 409);
    assert.equal((await update(order, 'Chờ xử lý')).status, 409);
    const shipped = await Promise.all([update(order, 'Đang giao hàng'), update(order, 'Đang giao hàng', {}, adminB.token)]);
    assert.ok(shipped.every(result => result.status === 200));
    assert.equal((await update(order, 'Đã giao hàng')).status, 409);
    const beforeDelivery = (await detail(order)).data.order;
    const failure = await injectFailure(sql => sql.startsWith('INSERT INTO order_status_history'), () => update(order, 'Đã giao hàng', { cod_payment_received: true }));
    assert.equal(failure.status, 500);
    assert.deepEqual((await detail(order)).data.order, beforeDelivery, 'Payment, order and history must all roll back');
    const delivered = await Promise.all([update(order, 'Đã giao hàng', { cod_payment_received: true }), update(order, 'Đã giao hàng', { cod_payment_received: true }, adminB.token)]);
    assert.ok(delivered.every(result => result.status === 200));
    const final = (await detail(order)).data.order;
    assert.equal(final.status, 'Đã giao hàng'); assert.equal(final.payment_status, 'Đã thanh toán'); assert.ok(final.transaction_date);
    assert.deepEqual(final.allowed_actions, []);
    assert.equal(final.history.length, 4);
    assert.equal(final.history.filter(row => row.action === 'status' && row.to_status === 'Đã giao hàng').length, 1);
    assert.equal((await approve(order)).status, 409);
    assert.equal((await update(order, 'Đang giao hàng')).status, 409);
});

test('Online approval never marks paid and Admin cannot bypass payment, including inconsistent manually paid data', async () => {
    const created = await createOrder({ method: 'ONLINE' }); assert.equal(created.status, 201);
    const order = created.data.order;
    assert.equal((await request(`/api/orders/${order.order_id}/payment`, { token: customer.token })).data.payment.can_simulate, false);
    const approval = await approve(order); assert.equal(approval.status, 200);
    assert.equal(approval.data.order.status, 'Chờ thanh toán'); assert.equal(approval.data.order.payment_status, 'Chưa thanh toán');
    assert.deepEqual(approval.data.order.allowed_actions, []);
    assert.equal(approval.data.order.history.at(-1).from_status, 'Chờ thanh toán');
    assert.equal(approval.data.order.history.at(-1).to_status, 'Chờ thanh toán');
    for (const next of ['Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng']) assert.equal((await update(order, next)).status, 409);
    await pool.execute("UPDATE payments SET payment_status='Đã thanh toán',transaction_date=NOW() WHERE order_id=?", [order.order_id]);
    assert.equal((await update(order, 'Chờ giao hàng')).status, 409, 'Admin must not repair paid pending state by bypassing payment handler');
    // Test-only system-confirmation fixture; no UI payment or success endpoint is added.
    await pool.execute("UPDATE orders SET status='Chờ giao hàng' WHERE order_id=?", [order.order_id]);
    assert.equal((await update(order, 'Đang giao hàng')).status, 200);
    assert.equal((await update(order, 'Đã giao hàng', { cod_payment_received: true })).status, 409);
    const delivered = await update(order, 'Đã giao hàng'); assert.equal(delivered.status, 200);
    assert.equal(delivered.data.order.payment_status, 'Đã thanh toán');
});

test('rejection requires valid Unicode reason, restores exactly once and shares real reason/history with the owner only', async () => {
    const created = await createOrder({ method: 'ONLINE' }); assert.equal(created.status, 201);
    const order = created.data.order, before = await stock(created.productId);
    for (const body of [{}, { reason: ' ' }, { reason: 'a'.repeat(501) }, { reason: 'bad\u0000value' }, { reason: '\ud800' }, { reason: 'Valid', user_id: 1 }]) assert.equal((await request(`/api/admin/orders/${order.order_id}/reject`, { method: 'PATCH', body })).status, 400);
    const reason = 'Không thể giao tại địa chỉ này.\nVui lòng liên hệ cửa hàng 🐾.';
    const attempts = await Promise.all([reject(order, reason), reject(order, reason, adminB.token), reject(order, reason)]);
    assert.ok(attempts.every(result => result.status === 200));
    assert.equal(await stock(created.productId), before + 2);
    assert.equal((await reject(order, 'Different reason')).status, 409);
    assert.equal((await approve(order)).status, 409);
    const ownerRead = await request(`/api/orders/${order.order_id}`, { token: customer.token });
    assert.equal(ownerRead.status, 200);
    const saved = ownerRead.data.order;
    assert.equal(saved.status, 'Đã hủy'); assert.equal(saved.payment_status, 'Đã hủy'); assert.equal(saved.approval_state, 'rejected');
    assert.equal(saved.rejection_reason, reason); assert.ok(saved.stock_restored_at);
    assert.equal(saved.history.length, 2); assert.equal(saved.history.at(-1).reason, reason);
    assert.ok([adminA.id, adminB.id].includes(saved.history.at(-1).actor_id));
    assert.ok(saved.history.at(-1).created_at); assert.ok(saved.history.at(-1).actor_name);
    assert.equal((await request(`/api/orders/${order.order_id}`, { token: stranger.token })).status, 404);
    const list = await request('/api/orders?status=' + encodeURIComponent('Đã hủy'), { token: customer.token });
    assert.ok(list.data.orders.some(row => row.order_id === order.order_id && row.rejection_reason === reason));
});

test('approve/reject races commit exactly one outcome and one audit event after creation', async () => {
    for (let iteration = 0; iteration < 4; iteration++) {
        const created = await createOrder(); assert.equal(created.status, 201);
        const order = created.data.order, before = await stock(created.productId);
        const results = await Promise.all([approve(order), reject(order, undefined, adminB.token)]);
        assert.equal(results.filter(result => result.status === 200).length, 1);
        assert.equal(results.filter(result => result.status === 409).length, 1);
        const saved = (await detail(order)).data.order;
        assert.equal(saved.history.length, 2);
        assert.equal(await stock(created.productId), saved.status === 'Đã hủy' ? before + 2 : before);
    }
});

test('multi-product approval failure and refusal failure roll back all changes, preserving historical prices', async () => {
    const first = await product(10, 'Sản phẩm còn hàng kiểm thử'), second = await product(10, 'Sản phẩm cần kiểm tra tồn');
    const created = await createOrder({ products: [{ product_id: first, quantity: 2 }, { product_id: second, quantity: 3 }] });
    assert.equal(created.status, 201); const order = created.data.order;
    await pool.execute('UPDATE products SET stock_quantity=-1 WHERE product_id=?', [second]);
    const failedApproval = await approve(order);
    assert.equal(failedApproval.status, 409);
    assert.equal(failedApproval.data.code, 'STOCK_REVIEW_REQUIRED');
    assert.equal(failedApproval.data.conflicts[0].product_id, second);
    const pending = (await detail(order)).data.order;
    assert.equal(pending.approved_at, null); assert.equal(pending.history.length, 1); assert.equal(await stock(first), 8);
    await pool.execute('UPDATE products SET stock_quantity=7,price=999999.99 WHERE product_id=?', [second]);
    const failure = await injectFailure(sql => sql.startsWith('UPDATE payments SET payment_status'), () => reject(order));
    assert.equal(failure.status, 500);
    assert.equal(await stock(first), 8); assert.equal(await stock(second), 7);
    const rolledBack = (await detail(order)).data.order;
    assert.equal(rolledBack.rejection_reason, null); assert.equal(rolledBack.stock_restored_at, null); assert.equal(rolledBack.history.length, 1);
    assert.equal(rolledBack.items.find(item => item.product_id === second).unit_price, '1000.25');
    assert.equal(rolledBack.total_amount, '5001.25');
    assert.equal((await reject(order)).status, 200);
    assert.equal(await stock(first), 10); assert.equal(await stock(second), 10);
});

test('insufficient Checkout stock cannot oversell concurrently; approval uses existing reservation without a second deduction', async () => {
    const id = await product(2);
    const purchases = await Promise.all([createOrder({ productId: id, quantity: 2 }), createOrder({ productId: id, quantity: 2 })]);
    assert.equal(purchases.filter(result => result.status === 201).length, 1);
    assert.equal(purchases.filter(result => result.status === 409).length, 1);
    assert.equal(await stock(id), 0);
    const saved = purchases.find(result => result.status === 201).data.order;
    assert.equal((await approve(saved)).status, 200);
    assert.equal(await stock(id), 0);
});

test('unproven legacy inventory remains readable but cannot be approved or restored without evidence', async () => {
    const created = await createOrder(); assert.equal(created.status, 201); const order = created.data.order;
    // Synthetic legacy uncertainty: no timestamp or verifiable writer evidence.
    await pool.execute('UPDATE orders SET stock_reserved_at=NULL,stock_reservation_source=NULL,request_fingerprint=NULL WHERE order_id=?', [order.order_id]);
    const before = await stock(created.productId);
    const saved = (await detail(order)).data.order;
    assert.equal(saved.review_required, true); assert.deepEqual(saved.allowed_actions, []); assert.ok(saved.review_reason);
    assert.equal((await approve(order)).status, 409); assert.equal((await reject(order)).status, 409);
    assert.equal(await stock(created.productId), before);
    assert.equal((await request(`/api/orders/${order.order_id}`, { token: customer.token })).status, 200);
});

test('rejection validation accepts 500 Unicode scalar values and payment cannot bypass unknown legacy reservations', async () => {
    const created = await createOrder(); assert.equal(created.status, 201);
    const reason = '🐾'.repeat(500);
    const response = await reject(created.data.order, reason);
    assert.equal(response.status, 200);
    assert.equal(response.data.order.rejection_reason, reason);
    const online = await createOrder({ method: 'ONLINE' }); assert.equal(online.status, 201);
    assert.equal((await approve(online.data.order)).status, 200);
    await pool.execute('UPDATE orders SET stock_reserved_at=NULL,stock_reservation_source=NULL WHERE order_id=?', [online.data.order.order_id]);
    const info = await request(`/api/orders/${online.data.order.order_id}/payment`, { token: customer.token });
    assert.equal(info.status, 200); assert.equal(info.data.payment.can_simulate, false);
    const payment = await request(`/api/orders/${online.data.order.order_id}/payment/simulate`, { method: 'POST', token: customer.token, body: { test_case: 'ONLINE_SUCCESS' } });
    assert.equal(payment.status, 409);
    assert.equal((await detail(online.data.order)).data.order.payment_status, 'Chưa thanh toán');
});
