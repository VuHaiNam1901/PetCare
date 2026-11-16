'use strict';

const pool = () => require('../config/db');
const invalid = () => { throw Object.assign(new Error('Invalid voucher customer search'), { status: 400, code: 'INVALID_VOUCHER_REQUEST' }); };

async function search({ page = 1, limit = 20, q = '' } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger((page - 1) * limit) ||
        typeof q !== 'string' || q.trim().length > 150 || /[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(q) ||
        [...q].some(value => value.codePointAt(0) > 65535)) invalid();
    const query = q.trim();
    const conditions = ["role='user'", "status='active'"];
    const params = [];
    if (query) {
        const like = '%' + query.replace(/[=%_]/g, value => '=' + value) + '%';
        conditions.push("(full_name LIKE ? ESCAPE '=' OR email LIKE ? ESCAPE '=' OR phone LIKE ? ESCAPE '=' OR CAST(user_id AS CHAR)=?)");
        params.push(like, like, like, query);
    }
    const where = conditions.join(' AND ');
    const db = await pool().getConnection();
    try {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db.query('START TRANSACTION READ ONLY');
        const [[{ total }]] = await db.execute('SELECT COUNT(*) AS total FROM `user` WHERE ' + where, params);
        const [users] = await db.query('SELECT user_id,full_name,email,phone FROM `user` WHERE ' + where + ' ORDER BY user_id DESC LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]);
        await db.commit();
        return { total, users };
    } catch (error) {
        await db.rollback();
        throw error;
    } finally { db.release(); }
}

module.exports = { search };
