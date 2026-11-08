const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pool = require('../config/db');
const orders = require('../models/order');

const workerCode = `
const pool=require('./config/db');
const service=require('./services/online-orders');
const {startOrderExpiryWorker}=require('./workers/order-expiry');
(async()=>{
 const worker=startOrderExpiryWorker({service,logger:{info(){},error(){}}});
 try { const result=await worker.runOnce(); if(result.failed)throw new Error('Synthetic worker scan failed'); }
 finally { await worker.stop(); await pool.end(); }
})().catch(error=>{console.error(error.code||'WORKER_FAILED');process.exitCode=1;});
`;
function scanInSeparateProcess() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', workerCode], { cwd: path.resolve(__dirname, '..'), env: { ...process.env },
            windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
            if (error) reject(Object.assign(new Error(`Synthetic expiry process failed: ${error.code || 'UNKNOWN'}`), { cause: error }));
            else resolve({ stdout, stderr });
        });
    });
}
async function fixture(count) {
    const [[category]] = await pool.query('SELECT category_id FROM categories ORDER BY category_id LIMIT 1');
    const [product] = await pool.execute(`INSERT INTO products
        (category_id,name,description,price,stock_quantity,image_url,status,created_at)
        VALUES (?,'Synthetic process fixture','Invented test data','10000.00',30,'/test.webp','Đang bán',NOW())`, [category.category_id]);
    const ids = [];
    for (let index = 0; index < count; index++) {
        const { order } = await orders.create(1, { source: 'buy-now', items: [{ product_id: product.insertId, quantity: 1 }],
            recipient_name: 'Process fixture', shipping_address: '123 Synthetic address', phone: '0900000000', payment_method: 'ONLINE', note: null }, randomUUID());
        await pool.execute(`UPDATE orders SET created_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 25 HOUR),
            payment_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE order_id=?`, [order.order_id]);
        ids.push(order.order_id);
    }
    return { productId: product.insertId, ids };
}
async function assertReleasedOnce(fixture_) {
    for (const id of fixture_.ids) {
        const saved = await orders.get(1, id);
        assert.equal(saved.status, 'Đã hủy');
        assert.ok(saved.stock_restored_at);
        assert.equal(saved.history.filter(event => event.action === 'payment_expired').length, 1);
    }
    const [[product]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [fixture_.productId]);
    assert.equal(product.stock_quantity, 30);
}
after(async () => { await pool.end(); });

test('two actual Node expiry processes release each reservation exactly once', async () => {
    const created = await fixture(4);
    await Promise.all([scanInSeparateProcess(), scanInSeparateProcess()]);
    await assertReleasedOnce(created);
    await scanInSeparateProcess();
    await assertReleasedOnce(created);
});

test('worker processes skip an owned order lock and catch it up on the next startup scan', async () => {
    const created = await fixture(2);
    const locked = await pool.getConnection();
    try {
        await locked.beginTransaction();
        await locked.execute('SELECT order_id FROM orders WHERE order_id=? FOR UPDATE', [created.ids[0]]);
        await Promise.all([scanInSeparateProcess(), scanInSeparateProcess()]);
        const [[held]] = await locked.execute('SELECT status,stock_restored_at FROM orders WHERE order_id=?', [created.ids[0]]);
        assert.equal(held.status, 'Chờ thanh toán');
        assert.equal(held.stock_restored_at, null);
        assert.equal((await orders.get(1, created.ids[1])).status, 'Đã hủy');
    } finally {
        await locked.rollback();
        locked.release();
    }
    await scanInSeparateProcess();
    await assertReleasedOnce(created);
});
