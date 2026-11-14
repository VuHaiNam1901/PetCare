// Synthetic HTTP/transaction checks only: no MySQL, migrations or app data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createWishlistModel } = require('../models/wishlist');
const { migrate } = require('../migrations/009-wishlists');
const accounts = [
    { user_id: 10, role: 'user', status: 'active' },
    { user_id: 11, role: 'user', status: 'active' },
    { user_id: 12, role: 'admin', status: 'active' },
    { user_id: 13, role: 'user', status: 'inactive' },
];
let active;
function fixture({ failCommit = false } = {}) {
    const saved = new Map(accounts.map(user => [user.user_id, new Set()]));
    const products = [
        { product_id: 1, name: 'Synthetic product', price: '100.00', stock_quantity: 5, status: 'Đang bán' },
        { product_id: 2, name: 'Out of stock', price: '50.00', stock_quantity: 0, status: 'Đang bán' },
        { product_id: 3, name: 'Stopped product', price: '75.00', stock_quantity: 3, status: 'Ngừng bán' },
    ];
    const locks = new Map(), log = [];
    const pool = { async getConnection() {
        let releaseLock, owner, snapshot;
        return {
            async beginTransaction() {},
            async execute(statement, values = []) {
                const sql = statement.replace(/\s+/g, ' ').trim();
                log.push({ sql, values });
                if (sql.startsWith('SELECT user_id,role,status')) {
                    owner = values[0];
                    if (sql.endsWith('FOR UPDATE')) {
                        const previous = locks.get(owner) || Promise.resolve();
                        locks.set(owner, new Promise(resolve => { releaseLock = resolve; }));
                        await previous;
                        snapshot = new Set(saved.get(owner));
                    }
                    return [[...accounts.filter(user => user.user_id === owner)]];
                }
                if (sql.startsWith('SELECT product_id FROM wishlists')) return [saved.get(values[0]).has(values[1]) ? [{ product_id: values[1] }] : []];
                if (sql.startsWith('SELECT product_id,status FROM products')) return [products.filter(product => product.product_id === values[0])];
                if (sql.startsWith('INSERT INTO wishlists')) {
                    assert.equal(saved.get(values[0]).has(values[1]), false, 'Unique owner/product constraint');
                    saved.get(values[0]).add(values[1]); return [{ affectedRows: 1 }];
                }
                if (sql.startsWith('DELETE FROM wishlists')) return [{ affectedRows: saved.get(values[0]).delete(values[1]) ? 1 : 0 }];
                if (sql.includes('FROM wishlists w')) return [[...saved.get(values[0])].map(id => ({ ...products.find(product => product.product_id === id) }))];
                throw new Error(`Unexpected synthetic SQL: ${sql}`);
            },
            async commit() { if (failCommit) throw new Error('Synthetic commit failure'); },
            async rollback() { if (snapshot) saved.set(owner, snapshot); },
            release() { releaseLock?.(); },
        };
    } };
    return { model: createWishlistModel({ pool }), saved, log };
}
function replace(module, exports) {
    const filename = require.resolve(module);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
replace('../config/auth', { secret: 'synthetic-wishlist-test-secret' });
replace('../models/user', { byId: async id => accounts.find(user => user.user_id === Number(id)) });
replace('../models/wishlist', Object.fromEntries(['get', 'add', 'remove'].map(name => [name, (...args) => active.model[name](...args)])));
let server, origin;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/wishlist', require('../routes/wishlist'));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}/api/wishlist`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function request(method = 'GET', path = '', actor = 10, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (actor) headers.Authorization = `Bearer ${jwt.sign({}, 'synthetic-wishlist-test-secret', { subject: String(actor), expiresIn: 60 })}`;
    const result = await fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
}

test('Wishlist requires an authenticated active customer for every operation', async () => {
    active = fixture();
    for (const [actor, expected] of [[null, 401], [12, 403], [13, 403]]) {
        for (const [method, path] of [['GET', ''], ['PUT', '/1'], ['DELETE', '/1']]) assert.equal((await request(method, path, actor)).status, expected);
    }
    assert.equal(active.log.length, 0);
});

test('Wishlist rejects malformed IDs and all owner/query/body spoofing', async () => {
    active = fixture();
    for (const id of ['0', '01', '-1', '1.5', '2147483648', 'NaN', '1%20OR%201=1']) assert.equal((await request('PUT', '/' + id)).status, 400);
    for (const method of ['PUT', 'DELETE']) {
        assert.equal((await request(method, '/1?user_id=11')).status, 400);
        for (const body of [{ user_id: 11 }, { product_id: 2 }, [], 'invalid']) assert.equal((await request(method, '/1', 10, body)).status, 400);
    }
    assert.equal((await request('GET', '?user_id=11')).status, 400);
    assert.equal(active.log.length, 0);
});

test('adding/removing is idempotent and persisted results belong only to the authenticated owner', async () => {
    active = fixture();
    const first = await request('PUT', '/1');
    assert.equal(first.status, 200); assert.equal(first.data.added, true);
    assert.deepEqual(first.data.products.map(product => product.product_id), [1]);
    assert.equal((await request('PUT', '/1')).data.added, false);
    assert.equal((await request('GET', '', 11)).data.products.length, 0);
    assert.equal((await request('DELETE', '/1', 11)).data.removed, false);
    assert.equal((await request()).data.products.length, 1);
    assert.equal((await request('DELETE', '/1')).data.removed, true);
    assert.equal((await request('DELETE', '/1')).data.removed, false);
    assert.equal((await request()).data.products.length, 0);
});

test('concurrent saves serialize on the user and never create duplicate products', async () => {
    active = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => active.model.add(10, 1)));
    assert.equal(results.filter(result => result.added).length, 1);
    assert.deepEqual([...active.saved.get(10)], [1]);
    assert.equal(active.log.filter(entry => entry.sql.startsWith('INSERT INTO wishlists')).length, 1);
    assert.ok(active.log.filter(entry => entry.sql.startsWith('SELECT user_id')).every(entry => entry.sql.endsWith('FOR UPDATE')));
});

test('out-of-stock products may be saved; missing or stopped products cannot be newly saved', async () => {
    active = fixture();
    assert.equal((await request('PUT', '/2')).status, 200);
    assert.equal((await request('PUT', '/3')).status, 409);
    assert.equal((await request('PUT', '/99')).status, 404);
    assert.deepEqual([...active.saved.get(10)], [2]);
});

test('a failed commit rolls back Wishlist membership', async () => {
    active = fixture({ failCommit: true });
    await assert.rejects(active.model.add(10, 1), /Synthetic commit failure/);
    assert.equal(active.saved.get(10).size, 0);
});

test('schema apply guard stops before any DDL when the expected database differs', async () => {
    let writes = 0, released = false;
    const pool = { async getConnection() { return {
        async query(sql) { if (sql.startsWith('SELECT DATABASE()')) return [[{ name: 'synthetic_fixture' }]]; writes++; throw new Error('Unexpected DDL'); },
        release() { released = true; },
    }; } };
    await assert.rejects(migrate(pool, { apply: true, expectedDatabase: 'another_database' }), /exact expected database/);
    assert.equal(writes, 0); assert.equal(released, true);
});
