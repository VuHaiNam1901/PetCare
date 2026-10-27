const { randomBytes, createHmac, createHash, timingSafeEqual } = require('node:crypto');
const { measure, measureSync } = require('./metrics');

function chatError(status, code, message) {
    return Object.assign(new Error(message), { status, code, chatSafe: true });
}

// The random component is a 256-bit capability. The signature binds it to the
// current authenticated account (or to a guest), without encoding account data.
function createSessionCodec(secret) {
    if (typeof secret !== 'string' || !secret.trim()) throw new Error('Chat session secret is required');
    const signature = (random, userId) => createHmac('sha256', secret)
        .update(`petcare-chat-v1\0${userId == null ? 'guest' : `user:${userId}`}\0${random}`).digest('base64url');
    return {
        issue(userId = null) {
            const random = randomBytes(32).toString('base64url');
            return `${random}.${signature(random, userId)}`;
        },
        verify(token, userId = null) {
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
            const [random, supplied] = token.split('.');
            return timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(random, userId)));
        }
    };
}

function requestHash(message) {
    return createHash('sha256').update(message).digest('hex');
}

function sessionStorageId(token) {
    return createHash('sha256').update(token).digest('hex');
}

function parseEnvelope(text) {
    try {
        const value = JSON.parse(text);
        return value?.v === 1 && typeof value.request_id === 'string' && typeof value.request_hash === 'string' &&
            value.response && typeof value.response.message === 'string' ? value : null;
    } catch { return null; }
}

function historyMessage(row) {
    if (row.sender === 'user') {
        let text = row.message;
        try {
            const saved = JSON.parse(row.message);
            if (saved?.v === 1 && typeof saved.text === 'string') text = saved.text;
        } catch { /* Legacy user messages are plain text. */ }
        return { role: 'user', text };
    }
    const response = parseEnvelope(row.message)?.response;
    // Older plain-text answers remain useful, without exposing envelope fields.
    const item = { role: 'assistant', text: response ? response.message : row.message };
    if (response && Array.isArray(response.products)) item.product_ids = response.products.map(product => product.product_id).filter(Number.isInteger);
    if (response?.context_search && typeof response.context_search === 'object') item.search = response.context_search;
    return item;
}

// This existing database uses utf8mb3. Escape JSON code units so emoji and
// supplementary characters round-trip without requiring a schema migration.
function storageJson(value) {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function createChatStore({ pool = require('../config/db'), lockTimeoutSeconds = 5 } = {}) {
    return {
        async withSession({ sessionId, userId = null }, callback) {
            const connection = await measure('session_wait_ms', () => pool.getConnection());
            const storageId = sessionStorageId(sessionId);
            const lockName = `pc_chat:${storageId.slice(0, 56)}`;
            let locked = false;
            let destroyed = false;
            try {
                const [locks] = await measure('session_wait_ms', () => connection.execute('SELECT GET_LOCK(?, ?) AS acquired', [lockName, lockTimeoutSeconds]));
                if (Number(locks[0]?.acquired) !== 1) throw chatError(409, 'SESSION_BUSY', 'Cuộc trò chuyện đang bận. Bạn vui lòng thử lại sau.');
                locked = true;
                const [owners] = await measure('mysql_history_load_ms', () => connection.execute('SELECT DISTINCT user_id FROM chat_histories WHERE session_id = ?', [storageId]));
                if (owners.some(row => (row.user_id == null ? null : String(row.user_id)) !== (userId == null ? null : String(userId)))) {
                    throw chatError(403, 'SESSION_FORBIDDEN', 'Phiên trò chuyện không thuộc tài khoản này hoặc không hợp lệ.');
                }
                return await callback({
                    async findRequest(requestId) {
                        // UUIDs contain no LIKE metacharacters. Keep the lookup
                        // compatible with older MySQL versions and legacy text rows.
                        const [rows] = await measure('mysql_history_load_ms', () => connection.execute(
                            "SELECT message FROM chat_histories WHERE session_id = ? AND sender = 'assistant' AND message LIKE ? ORDER BY chat_history_id DESC LIMIT 1",
                            [storageId, `%"request_id":"${requestId}"%`]));
                        for (const row of rows) {
                            const envelope = parseEnvelope(row.message);
                            if (envelope?.request_id === requestId) return envelope;
                        }
                        return null;
                    },
                    async history() {
                        const [rows] = await measure('mysql_history_load_ms', () => connection.execute(
                            "SELECT sender, message FROM chat_histories WHERE session_id = ? AND sender IN ('user', 'assistant', 'bot') ORDER BY chat_history_id DESC LIMIT 8", [storageId]));
                        return measureSync('context_history_ms', () => rows.reverse().map(historyMessage));
                    },
                    async savePair({ message, requestId, hash, response }) {
                        const userMessage = storageJson({ v: 1, request_id: requestId, text: message });
                        const envelope = storageJson({ v: 1, request_id: requestId, request_hash: hash, response });
                        if (Buffer.byteLength(envelope, 'utf8') > 60000 || Buffer.byteLength(userMessage, 'utf8') > 60000) throw chatError(503, 'RESPONSE_TOO_LARGE', 'Không thể lưu câu trả lời. Bạn vui lòng thử lại.');
                        let started = false;
                        try {
                            await measure('mysql_history_save_ms', () => connection.beginTransaction());
                            started = true;
                            await measure('mysql_history_save_ms', () => connection.execute(
                                'INSERT INTO chat_histories (user_id, message, sender, created_at, session_id) VALUES (?, ?, ?, NOW(), ?), (?, ?, ?, NOW(), ?)',
                                [userId, userMessage, 'user', storageId, userId, envelope, 'assistant', storageId]));
                            await measure('mysql_history_save_ms', () => connection.commit());
                        } catch (error) {
                            if (started) {
                                try { await measure('mysql_history_save_ms', () => connection.rollback()); }
                                catch { connection.destroy(); destroyed = true; }
                            }
                            throw error;
                        }
                    }
                });
            } finally {
                if (locked && !destroyed) {
                    try { await measure('mysql_session_ms', () => connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])); }
                    catch { connection.destroy(); destroyed = true; }
                }
                if (!destroyed) connection.release();
            }
        }
    };
}

module.exports = { createSessionCodec, createChatStore, sessionStorageId, requestHash, chatError };
