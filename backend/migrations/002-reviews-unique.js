const { backup } = require('./001-admin-orders');

async function migrate(pool) {
    const db = await pool.getConnection();
    let locked = false;
    let namedLock = false;
    try {
        const [[lock]] = await db.query("SELECT GET_LOCK('petcare_uc14_migration', 0) AS acquired");
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another review migration is running');
        namedLock = true;
        await db.query('LOCK TABLES reviews WRITE');
        locked = true;
        const [indexes] = await db.query('SHOW INDEX FROM reviews');
        const unique = new Map();
        for (const row of indexes.filter(row => !row.Non_unique)) {
            if (!unique.has(row.Key_name)) unique.set(row.Key_name, []);
            unique.get(row.Key_name).push(row);
        }
        if ([...unique.values()].some(rows => rows.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name).join(',') === 'user_id,product_id')) {
            console.log('Review UNIQUE already present; no changes.');
            return;
        }
        const [[mode]] = await db.query('SELECT @@SESSION.sql_mode AS mode');
        if (mode.mode.includes('NO_BACKSLASH_ESCAPES')) throw new Error('Backup requires standard SQL escaping');
        const [triggers] = await db.query("SHOW TRIGGERS WHERE `Table` = 'reviews'");
        if (triggers.length) throw new Error('Review triggers require a separately reviewed backup');
        const directory = await backup(db, ['reviews'], 'uc14');
        console.log('Verified pre-migration review backup:', directory);
        const [duplicates] = await db.query('SELECT user_id, product_id FROM reviews GROUP BY user_id, product_id HAVING COUNT(*) > 1 LIMIT 1');
        if (duplicates.length) throw new Error('Duplicate reviews found; no rows deleted, manual review required');
        const [[before]] = await db.query('SELECT COUNT(*) AS count FROM reviews');
        await db.query('ALTER TABLE reviews ADD UNIQUE KEY uq_reviews_user_product (user_id, product_id)');
        const [[after]] = await db.query('SELECT COUNT(*) AS count FROM reviews');
        if (before.count !== after.count) throw new Error('Review count verification failed');
        console.log(`Review UNIQUE added; ${after.count} existing reviews preserved.`);
    } finally {
        if (locked) await db.query('UNLOCK TABLES');
        if (namedLock) await db.query("SELECT RELEASE_LOCK('petcare_uc14_migration')");
        db.release();
    }
}
module.exports = { migrate };
if (require.main === module) {
    const pool = require('../config/db');
    migrate(pool).catch(error => { console.error('Review migration stopped:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
