const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const app = require('../server');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

test('authentication integration with temporary accounts and existing MySQL', async () => {
    const email = `auth-test-${randomUUID()}@example.com`;
    const password = 'Test-password-2026!';
    let id;
    app.get('/__test/admin', authenticate, authorize('admin'), (req, res) => res.json({ success: true }));
    app.get('/__test/user', authenticate, authorize('user', 'admin'), (req, res) => res.json({ success: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, method = 'GET', body, token) {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await res.json();
        assert.equal(/"password"|"\$2[aby]\$/.test(JSON.stringify(data)), false);
        return { status: res.status, data };
    }
    async function snapshot() {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return { products: products.length, categories: categories.length, digest: createHash('sha256').update(JSON.stringify([products, categories])).digest('hex') };
    }
    const before = await snapshot();
    try {
        const account = { full_name: 'Auth Test', email, password };
        assert.equal((await request('/api/auth/register', 'POST', { ...account, role: 'admin' })).status, 400);
        assert.equal((await request('/api/auth/register', 'POST', { ...account, password: 'short' })).status, 400);
        assert.equal((await request('/api/auth/register', 'POST', { ...account, email: 'invalid' })).status, 400);
        const registered = await request('/api/auth/register', 'POST', account);
        assert.equal(registered.status, 201);
        id = registered.data.user.user_id;
        assert.equal(registered.data.user.role, 'user');
        const [[stored]] = await pool.execute('SELECT password FROM `user` WHERE user_id = ?', [id]);
        assert.ok(await bcrypt.compare(password, stored.password));
        assert.equal((await request('/api/auth/register', 'POST', account)).status, 409);
        assert.equal((await request('/api/auth/login', 'POST', { email, password: 'wrong' })).status, 401);
        const login = await request('/api/auth/login', 'POST', { email, password });
        assert.equal(login.status, 200);
        const token = login.data.token;
        assert.equal((await request('/api/auth/me')).status, 401);
        assert.equal((await request('/api/auth/me', 'GET', undefined, 'invalid')).status, 401);
        const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(id), expiresIn: -1 });
        assert.equal((await request('/api/auth/me', 'GET', undefined, expired)).status, 401);
        assert.equal((await request('/api/auth/me', 'GET', undefined, token)).data.user.user_id, id);
        assert.equal((await request('/api/users/me', 'PUT', { full_name: 'Updated Test', phone: '+84123456789', address: 'Test address' }, token)).status, 200);
        assert.equal((await request('/api/users/me', 'PUT', { role: 'admin' }, token)).status, 400);
        assert.equal((await request('/api/users/me', 'PUT', { status: 'active' }, token)).status, 400);
        assert.equal((await request('/__test/admin', 'GET', undefined, token)).status, 403);
        assert.equal((await request('/__test/user', 'GET', undefined, token)).status, 200);
        // Change only this temporary account to exercise current database role/status checks.
        await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', id]);
        assert.equal((await request('/__test/admin', 'GET', undefined, token)).status, 200);
        await pool.execute('UPDATE `user` SET status = ? WHERE user_id = ?', ['inactive', id]);
        assert.equal((await request('/api/auth/me', 'GET', undefined, token)).status, 403);
        assert.equal((await request('/api/auth/login', 'POST', { email, password })).status, 403);
        for (const path of ['/', '/api/health/db', '/api/health/tables', '/api/products', '/api/categories']) assert.equal((await request(path)).status, 200);
        assert.deepEqual(await snapshot(), before);
        console.log(`Read-only data verified: ${before.products} products, ${before.categories} categories; identical content`);
        const missing = spawnSync(process.execPath, ['-e', "require('./config/auth')"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, JWT_SECRET: '' }, encoding: 'utf8' });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /JWT_SECRET is required/);
    } finally {
        await pool.execute('DELETE FROM `user` WHERE email = ?', [email]);
        await new Promise(resolve => server.close(resolve));
        await pool.end();
    }
});
