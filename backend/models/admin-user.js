const pool = require('../config/db');
const fields = 'user_id, full_name, email, phone, address, role, status, created_at';
// Existing auth contract: registration creates active, inactive is denied.
exports.statuses = ['active', 'inactive'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

exports.get = async userId => {
    const [[user]] = await pool.execute(`SELECT ${fields} FROM \`user\` WHERE user_id = ? AND role = ?`, [userId, 'user']);
    if (!user) fail(404, 'Customer account not found');
    return user;
};

exports.list = async ({ page, limit, q, status }) => {
    const conditions = ['role = ?'];
    const params = ['user'];
    if (q !== undefined) {
        conditions.push("(full_name LIKE ? ESCAPE '=' OR email LIKE ? ESCAPE '=')");
        const search = '%' + q.replace(/[=%_]/g, char => '=' + char) + '%';
        params.push(search, search);
    }
    if (status !== undefined) { conditions.push('status = ?'); params.push(status); }
    const where = conditions.join(' AND ');
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM \`user\` WHERE ${where}`, params);
        const [users] = await db.query(`SELECT ${fields} FROM \`user\` WHERE ${where} ORDER BY user_id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        await db.commit();
        return { total, users };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};

exports.setStatus = async (adminId, userId, status) => {
    if (!exports.statuses.includes(status)) fail(400, 'Invalid account status');
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[admin]] = await db.execute('SELECT role, status FROM `user` WHERE user_id = ? FOR SHARE', [adminId]);
        if (!admin || admin.role !== 'admin' || admin.status !== 'active') fail(403, 'Active admin account required');
        const [[target]] = await db.execute('SELECT user_id FROM `user` WHERE user_id = ? AND role = ? FOR UPDATE', [userId, 'user']);
        if (!target) fail(404, 'Customer account not found');
        await db.execute('UPDATE `user` SET status = ? WHERE user_id = ? AND role = ?', [status, userId, 'user']);
        const [[user]] = await db.execute(`SELECT ${fields} FROM \`user\` WHERE user_id = ? AND role = ?`, [userId, 'user']);
        await db.commit();
        return user;
    } catch (error) {
        await db.rollback();
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Account is busy; retry the request';
        }
        throw error;
    } finally { db.release(); }
};
