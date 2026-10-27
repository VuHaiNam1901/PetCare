const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID, createHash } = require('node:crypto');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { secret } = require('../config/auth');
const { createChatRouter } = require('../routes/chat');
const { sessionStorageId } = require('../ai/sessions');

test('Chat real MySQL: guest/user persistence, Unicode, session locks, atomic replay and cleanup', { skip: process.env.UC13_LIVE_DB_TEST !== '1' }, async () => {
    const email = `chat-db-${randomUUID()}@example.com`;
    const sessions = new Set();
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    async function snapshot() {
        const tables = {};
        for (const name of ['products', 'categories', 'chat_histories']) tables[name] = (await pool.query(`SELECT * FROM \`${name}\` ORDER BY 1`))[0];
        return digest(tables);
    }
    const before = await snapshot();
    const app = express();
    app.use(express.json());
    let generated = 0;
    const histories = [];
    app.use('/api/chat', createChatRouter({ assistant: { async reply({ message, history }) {
        generated++; histories.push(history);
        return { message: `Mình đã nhận câu hỏi: ${message}`, products: [], follow_up: null, warnings: [], code: 'OK', model: 'mock', mode: 'care', intent: 'care', context_search: {} };
    } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/chat`;
    async function post(body, token) {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        const data = await response.json();
        if (data.session_id) sessions.add(sessionStorageId(data.session_id));
        return { status: response.status, data };
    }
    try {
        const guest = await post({ message: 'Xin chào 🐾', request_id: randomUUID() });
        assert.equal(guest.status, 200);
        const follow = { message: 'Còn chăm sóc thế nào?', request_id: randomUUID(), session_id: guest.data.session_id };
        const concurrent = await Promise.all([post(follow), post(follow)]);
        assert.ok(concurrent.every(result => result.status === 200));
        assert.equal(concurrent.filter(result => result.data.replayed).length, 1);
        assert.equal(generated, 2);
        assert.equal(histories[1][0].text, 'Xin chào 🐾');
        assert.equal((await post({ ...follow, message: 'Different' })).status, 409);
        const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM chat_histories WHERE session_id=?', [sessionStorageId(guest.data.session_id)]);
        assert.equal(count.total, 4);
        const [created] = await pool.execute('INSERT INTO `user` (full_name,email,password,role,status,created_at) VALUES (?,?,?,?,?,NOW())', ['Chat fixture', email, 'test-fixture-never-used-for-login', 'user', 'active']);
        const token = jwt.sign({}, secret, { subject: String(created.insertId), expiresIn: 60 });
        const user = await post({ message: 'Chăm sóc mèo', request_id: randomUUID() }, token);
        assert.equal(user.status, 200);
        assert.equal((await post({ message: 'Read wrong owner', request_id: randomUUID(), session_id: user.data.session_id })).status, 403);
        assert.equal((await post({ message: 'Cross guest', request_id: randomUUID(), session_id: guest.data.session_id }, token)).status, 403);
        await pool.execute('UPDATE `user` SET status=? WHERE user_id=?', ['inactive', created.insertId]);
        assert.equal((await post({ message: 'Blocked', request_id: randomUUID(), session_id: user.data.session_id }, token)).status, 403);
        console.log('Actual MySQL chat persistence/replay/UTF-8 and guest/account isolation passed; Gemini mock only.');
    } finally {
        try {
            for (const id of sessions) await pool.execute('DELETE FROM chat_histories WHERE session_id=?', [id]);
            await pool.execute('DELETE FROM `user` WHERE email=?', [email]);
            assert.equal(await snapshot(), before);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
});
