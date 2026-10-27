const pool = require('../config/db');
const fields = 'user_id, full_name, email, phone, address, role, status, created_at';

exports.byId = async (id) => {
    const [rows] = await pool.execute(`SELECT ${fields} FROM \`user\` WHERE user_id = ?`, [id]);
    return rows[0];
};
exports.byEmail = async (email) => {
    const [rows] = await pool.execute(`SELECT ${fields}, password FROM \`user\` WHERE email = ?`, [email]);
    return rows[0];
};
exports.create = async (data, hash) => {
    const [result] = await pool.execute(
        'INSERT INTO `user` (full_name, email, password, phone, address, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [data.full_name, data.email, hash, data.phone ?? null, data.address ?? null, 'user', 'active']
    );
    return exports.byId(result.insertId);
};
exports.update = async (id, data) => {
    const keys = Object.keys(data);
    await pool.execute(`UPDATE \`user\` SET ${keys.map(key => `\`${key}\` = ?`).join(', ')} WHERE user_id = ?`, [...Object.values(data), id]);
    return exports.byId(id);
};
