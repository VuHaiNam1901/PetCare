// This file runs in its own Node test process. Only its host timezone changes;
// MySQL's session and stored legacy wall-clock values remain untouched.
const previousTimezone = process.env.TZ;
process.env.TZ = 'UTC';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pool = require('../config/db');
const orders = require('../models/order');
const payments = require('../models/payment');
const admin = require('../models/admin-order');
const { createOnlineOrderService } = require('../services/online-orders');
const service = createOnlineOrderService({ pool });

async function create() {
    const [[category]] = await pool.query('SELECT category_id FROM categories ORDER BY category_id LIMIT 1');
    const [product] = await pool.execute(`INSERT INTO products
        (category_id,name,description,price,stock_quantity,image_url,status,created_at)
        VALUES (?,'Timezone review fixture','Synthetic only','100000.00',100,'/test.webp','Đang bán',NOW())`, [category.category_id]);
    const result = await orders.create(1, { source: 'buy-now', items: [{ product_id: product.insertId, quantity: 1 }],
        recipient_name: 'Timezone fixture', shipping_address: '123 Synthetic address', phone: '0900000000', payment_method: 'ONLINE', note: null }, randomUUID());
    return { ...result, productId: product.insertId };
}
after(async () => {
    await pool.end();
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
});

test('new payment and Admin approval use the database clock when Node runs in UTC', async () => {
    const created = await create();
    assert.equal(created.order.review_required, false);
    assert.equal((await payments.get(1, created.order.order_id)).can_simulate, true);
    await payments.simulate(1, created.order.order_id, 'ONLINE_SUCCESS');
    const approved = await admin.approve(2, created.order.order_id);
    assert.equal(approved.status, 'Chờ giao hàng');
    assert.equal(approved.review_required, false);
});

test('expiry releases held stock despite different Node and database timezones', async () => {
    const created = await create();
    await pool.execute(`UPDATE orders SET created_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 25 HOUR),
        payment_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE order_id=?`, [created.order.order_id]);
    const result = await service.expireBatch({ limit: 100 });
    assert.equal(result.errors.some(error => error.order_id === created.order.order_id), false);
    assert.ok(result.expired >= 1);
    const saved = await orders.get(1, created.order.order_id);
    assert.equal(saved.status, 'Đã hủy');
    const [[product]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [created.productId]);
    assert.equal(product.stock_quantity, 100);
});

test('legacy order dates retain the database instant independently of Node timezone', async () => {
    const legacy = await orders.get(1, 173);
    const [[row]] = await pool.execute('SELECT UNIX_TIMESTAMP(order_date) AS seconds FROM orders WHERE order_id=173');
    assert.equal(new Date(legacy.order_date).getTime(), Number(row.seconds) * 1000);
    assert.equal(legacy.workflow_version, null);
});

test('future reservation markers still fail closed against the database clock', async () => {
    const created = await create();
    await pool.execute('UPDATE orders SET stock_reserved_at=DATE_ADD(NOW(),INTERVAL 1 DAY) WHERE order_id=?', [created.order.order_id]);
    assert.equal((await orders.get(1, created.order.order_id)).review_required, true);
    await assert.rejects(payments.simulate(1, created.order.order_id, 'ONLINE_SUCCESS'));
});
