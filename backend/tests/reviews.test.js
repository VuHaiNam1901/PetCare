const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

test('UC14: delivered purchase, uniqueness, privacy, discontinued products and cleanup', async () => {
    const emails = [0, 1, 2].map(i => `review-test-${randomUUID()}-${i}@example.com`);
    const accounts = [];
    const productIds = [];
    let categoryId;
    let before;
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function catalog() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products, categories, hash: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    async function request(url, method = 'GET', body, token = accounts[0]?.token) {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        assert.equal(/"password"|\$2[aby]\$/.test(JSON.stringify(data)), false);
        return { status: response.status, data };
    }
    const post = (id, body = { rating: 5, comment: 'Good product' }, token = accounts[0].token) => request(`/api/products/${id}/reviews`, 'POST', body, token);
    async function orderFixture(userId, productId, status) {
        // Synthetic order fixtures only; no payment/order workflow is modified.
        const [created] = await pool.execute('INSERT INTO orders (user_id,order_date,total_amount,shipping_address,phone,status,note,approved_at) VALUES (?,NOW(),10,?,?,?, ?,NOW())', [userId, 'Private test address', '0123456789', status, 'UC14 fixture']);
        await pool.execute('INSERT INTO order_details (order_id,product_id,quantity,unit_price,subtotal) VALUES (?,?,1,10,10)', [created.insertId, productId]);
        return created.insertId;
    }
    try {
        before = await catalog();
        for (let i = 0; i < emails.length; i++) {
            const created = await request('/api/auth/register', 'POST', { full_name: `Review Tester ${i}`, email: emails[i], password: 'Review-test-2026!', phone: '0123456789', address: 'Private test address' }, null);
            assert.equal(created.status, 201);
            const login = await request('/api/auth/login', 'POST', { email: emails[i], password: 'Review-test-2026!' }, null);
            assert.equal(login.status, 200);
            accounts.push({ id: created.data.user.user_id, token: login.data.token });
        }
        await pool.execute('UPDATE `user` SET role=? WHERE user_id=?', ['admin', accounts[2].id]);
        const [category] = await pool.execute('INSERT INTO categories (name,description,created_at) VALUES (?,NULL,NOW())', [`Review-${randomUUID()}`]);
        categoryId = category.insertId;
        for (let i = 0; i < 2; i++) {
            const [product] = await pool.execute('INSERT INTO products (category_id,name,description,price,stock_quantity,image_url,status,created_at) VALUES (?,?,NULL,10,10,?,?,NOW())', [categoryId, `Review product ${i}`, before.products[0].image_url, 'Đang bán']);
            productIds.push(product.insertId);
        }
        const [first, pending] = productIds;
        const deliveredId = await orderFixture(accounts[0].id, first, 'Đã giao hàng');
        await orderFixture(accounts[1].id, first, 'Đã giao hàng');
        await orderFixture(accounts[0].id, pending, 'Đang giao hàng');
        const [savedOrders] = await pool.execute('SELECT * FROM orders WHERE user_id IN (?,?) ORDER BY order_id', [accounts[0].id, accounts[1].id]);
        const [savedDetails] = await pool.execute('SELECT d.* FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id IN (?,?) ORDER BY d.order_detail_id', [accounts[0].id, accounts[1].id]);
        const empty = await request(`/api/products/${first}/reviews`, 'GET', undefined, null);
        assert.equal(empty.status, 200);
        assert.equal(empty.data.total, 0);
        assert.equal((await post(pending)).status, 403, 'Own order is not delivered');
        assert.equal((await post(pending, undefined, accounts[1].token)).status, 403, 'No owned purchase');
        assert.equal((await post(2147483647)).status, 404);
        for (const rating of [0, 6, -1, 2.5, '5', null]) assert.equal((await post(first, { rating, comment: 'Test' })).status, 400);
        for (const comment of ['', ' ', null, 10, 'x'.repeat(2001), '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '\u0000\u0001']) assert.equal((await post(first, { rating: 5, comment })).status, 400);
        for (const extra of [{ user_id: accounts[1].id }, { reviewer_name: 'Impersonated' }, { email: emails[1] }, { image_url: '/images/products/a.webp' }]) assert.equal((await post(first, { rating: 5, comment: 'Test', ...extra })).status, 400);
        const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(accounts[0].id), expiresIn: -1 });
        for (const token of [null, 'invalid', expired]) {
            assert.equal((await post(first, undefined, token)).status, 401);
            assert.equal((await request('/api/users/me/reviews', 'GET', undefined, token)).status, 401);
        }
        assert.equal((await post(first, undefined, accounts[2].token)).status, 403);
        assert.equal((await request('/api/users/me/reviews', 'GET', undefined, accounts[2].token)).status, 403);
        const created = await post(first, { rating: 5, comment: '\u0000Great product\u202E' });
        assert.equal(created.status, 201);
        assert.equal(created.data.review.comment, 'Great product');
        assert.equal((await post(first)).status, 409);
        await assert.rejects(pool.execute('INSERT INTO reviews (user_id,product_id,rating,comment,created_at) VALUES (?,?,5,?,NOW())', [accounts[0].id, first, 'Duplicate fixture']), { code: 'ER_DUP_ENTRY' });
        const discontinued = await request(`/api/admin/products/${first}`, 'DELETE', undefined, accounts[2].token);
        assert.equal(discontinued.status, 200);
        assert.equal(discontinued.data.product.status, 'Ngừng bán');
        assert.equal((await request(`/api/products/${first}/reviews`, 'GET', undefined, null)).data.total, 1);
        const concurrent = await Promise.all(Array.from({ length: 5 }, () => post(first, { rating: 4, comment: 'Bought before discontinuation' }, accounts[1].token)));
        assert.equal(concurrent.filter(result => result.status === 201).length, 1);
        assert.equal(concurrent.filter(result => result.status === 409).length, 4);
        const publicReviews = await request(`/api/products/${first}/reviews?page=1&limit=1`, 'GET', undefined, null);
        assert.equal(publicReviews.data.total, 2);
        assert.equal(publicReviews.data.reviews.length, 1);
        assert.deepEqual(Object.keys(publicReviews.data.reviews[0]).sort(), ['review_id', 'rating', 'comment', 'created_at', 'reviewer_name'].sort());
        const serialized = JSON.stringify(publicReviews.data);
        for (const privateValue of [...emails, '0123456789', 'Private test address', 'user_id', 'email', 'phone', 'address']) assert.equal(serialized.includes(privateValue), false);
        assert.notEqual(publicReviews.data.reviews[0].review_id, (await request(`/api/products/${first}/reviews?page=2&limit=1`, 'GET', undefined, null)).data.reviews[0].review_id);
        const mineA = await request('/api/users/me/reviews');
        const mineB = await request('/api/users/me/reviews', 'GET', undefined, accounts[1].token);
        assert.equal(mineA.data.total, 1);
        assert.equal(mineB.data.total, 1);
        assert.notEqual(mineA.data.reviews[0].review_id, mineB.data.reviews[0].review_id);
        assert.equal(mineA.data.reviews[0].product_status, 'Ngừng bán');
        for (const url of ['/api/products/nope/reviews', `/api/products/${first}/reviews?page=0`, `/api/products/${first}/reviews?limit=101`, '/api/users/me/reviews?user_id=1']) assert.equal((await request(url)).status, 400);
        assert.equal((await request('/api/products/2147483647/reviews', 'GET', undefined, null)).status, 404);
        await pool.execute('UPDATE `user` SET status=? WHERE user_id=?', ['inactive', accounts[1].id]);
        assert.equal((await post(pending, undefined, accounts[1].token)).status, 403);
        assert.equal((await request('/api/users/me/reviews', 'GET', undefined, accounts[1].token)).status, 403);
        assert.equal((await request(`/api/products/${first}/reviews`, 'GET', undefined, null)).data.total, 2, 'Locking an author does not erase published reviews');
        assert.deepEqual((await pool.execute('SELECT * FROM orders WHERE user_id IN (?,?) ORDER BY order_id', [accounts[0].id, accounts[1].id]))[0], savedOrders);
        assert.deepEqual((await pool.execute('SELECT d.* FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id IN (?,?) ORDER BY d.order_detail_id', [accounts[0].id, accounts[1].id]))[0], savedDetails);
        assert.equal((await request(`/api/orders/${deliveredId}`)).status, 200);
        console.log('Review eligibility, DB UNIQUE/concurrency, discontinued products, privacy, sanitation and unchanged orders verified.');
    } finally {
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            for (const email of emails) {
                const [[user]] = await db.execute('SELECT user_id FROM `user` WHERE email=?', [email]);
                if (!user) continue;
                await db.execute('DELETE FROM reviews WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE d FROM order_details d JOIN orders o ON o.order_id=d.order_id WHERE o.user_id=?', [user.user_id]);
                await db.execute('DELETE FROM orders WHERE user_id=?', [user.user_id]);
                await db.execute('DELETE FROM `user` WHERE user_id=?', [user.user_id]);
            }
            for (const productId of productIds) await db.execute('DELETE FROM products WHERE product_id=?', [productId]);
            if (categoryId) await db.execute('DELETE FROM categories WHERE category_id=?', [categoryId]);
            await db.commit();
            if (before) {
                const after = await catalog();
                assert.equal(after.hash, before.hash);
                console.log(`Review cleanup verified: ${after.products.length} products / ${after.categories.length} categories identical.`);
            }
            const [remaining] = await db.execute('SELECT user_id FROM `user` WHERE email IN (?,?,?)', emails);
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
