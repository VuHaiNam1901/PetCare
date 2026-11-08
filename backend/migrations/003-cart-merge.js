const pool = require('../config/db');

async function migrate(database = pool) {
    const connection = await database.getConnection();
    let acquired = false;
    try {
        const [[lock]] = await connection.query("SELECT GET_LOCK('petcare_cart_merge_migration', 0) AS acquired");
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another cart merge migration is running');
        acquired = true;
        // Additive metadata only: no ALTER, backfill, or catalog/cart update.
        await connection.query(`CREATE TABLE IF NOT EXISTS cart_merge_requests (
            merge_request_id BIGINT NOT NULL AUTO_INCREMENT,
            user_id INT NOT NULL,
            idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (merge_request_id),
            UNIQUE KEY uq_cart_merge_user_key (user_id, idempotency_key_hash),
            CONSTRAINT fk_cart_merge_user FOREIGN KEY (user_id) REFERENCES \`user\` (user_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        const [columns] = await connection.query('SHOW COLUMNS FROM cart_merge_requests');
        for (const required of ['merge_request_id', 'user_id', 'idempotency_key_hash', 'request_fingerprint', 'created_at']) if (!columns.some(column => column.Field === required)) throw new Error('Unexpected cart_merge_requests schema');
        const [indexes] = await connection.query('SHOW INDEX FROM cart_merge_requests');
        const unique = indexes.filter(index => index.Key_name === 'uq_cart_merge_user_key' && !index.Non_unique).sort((a, b) => a.Seq_in_index - b.Seq_in_index);
        if (unique.map(index => index.Column_name).join(',') !== 'user_id,idempotency_key_hash') throw new Error('Missing cart merge idempotency constraint');
        return { table: 'cart_merge_requests', additiveOnly: true };
    } finally {
        if (acquired) await connection.query("SELECT RELEASE_LOCK('petcare_cart_merge_migration')");
        connection.release();
    }
}

if (require.main === module) migrate().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { migrate };
