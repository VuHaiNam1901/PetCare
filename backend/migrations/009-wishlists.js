// Standalone, additive Wishlist schema. Never alters existing tables, copies
// customer rows, creates backups, or enables financial workflow migrations.
const { createHash } = require('node:crypto');

async function verify(db) {
    const [[table]] = await db.execute("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wishlists'");
    if (!table || table.ENGINE !== 'InnoDB') throw new Error('Wishlist requires its InnoDB table');
    const [columns] = await db.query('SHOW COLUMNS FROM wishlists');
    const byName = new Map(columns.map(column => [column.Field, column]));
    for (const name of ['user_id', 'product_id']) {
        const column = byName.get(name);
        if (!column || !/^int(?:\(\d+\))?$/i.test(column.Type) || column.Null !== 'NO') throw new Error(`Unexpected wishlists.${name} definition`);
    }
    const created = byName.get('created_at');
    if (!created || !/^datetime\(3\)$/i.test(created.Type) || created.Null !== 'NO') throw new Error('Unexpected wishlists.created_at definition');
    const [indexes] = await db.query('SHOW INDEX FROM wishlists');
    const primary = indexes.filter(index => index.Key_name === 'PRIMARY' && Number(index.Non_unique) === 0)
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
    if (primary.join(',') !== 'user_id,product_id') throw new Error('Wishlist requires a unique owner/product primary key');
    const [foreignKeys] = await db.execute(`SELECT k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='wishlists' AND k.REFERENCED_TABLE_SCHEMA=DATABASE()`);
    for (const [column, parent, key] of [['user_id', 'user', 'user_id'], ['product_id', 'products', 'product_id']]) {
        if (!foreignKeys.some(row => row.COLUMN_NAME === column && row.REFERENCED_TABLE_NAME === parent && row.REFERENCED_COLUMN_NAME === key && row.DELETE_RULE === 'CASCADE')) {
            throw new Error('Wishlist requires its owner/product foreign keys');
        }
    }
    return true;
}

async function migrate(pool, { apply = false, expectedDatabase } = {}) {
    const db = await pool.getConnection();
    let lockName, locked = false;
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS name');
        if (!selected.name || (apply && (!expectedDatabase || selected.name !== expectedDatabase))) throw new Error('Wishlist apply requires the exact expected database');
        lockName = 'petcare_wishlist_' + createHash('sha256').update(selected.name).digest('hex').slice(0, 32);
        const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another Wishlist migration is running');
        locked = true;
        const [parents] = await db.execute("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('user','products')");
        const [parentColumns] = await db.execute("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='user' AND COLUMN_NAME='user_id') OR (TABLE_NAME='products' AND COLUMN_NAME='product_id'))");
        if (parents.length !== 2 || parents.some(table => table.ENGINE !== 'InnoDB') || parentColumns.length !== 2 || parentColumns.some(column => !/^int(?:\(\d+\))?$/i.test(column.COLUMN_TYPE))) {
            throw new Error('Wishlist requires existing InnoDB user/products with signed integer IDs');
        }
        const [[existing]] = await db.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wishlists'");
        if (existing) { await verify(db); return { ready: true, created: false }; }
        if (!apply) return { ready: false, created: false, requiresApply: true };
        await db.query(`CREATE TABLE wishlists (
            user_id INT NOT NULL,
            product_id INT NOT NULL,
            created_at DATETIME(3) NOT NULL,
            PRIMARY KEY (user_id,product_id),
            KEY idx_wishlist_product (product_id),
            CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES \`user\` (user_id) ON DELETE CASCADE,
            CONSTRAINT fk_wishlist_product FOREIGN KEY (product_id) REFERENCES products (product_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await verify(db);
        return { ready: true, created: true, additiveOnly: true };
    } finally {
        try { if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
        finally { db.release(); }
    }
}

module.exports = { migrate, verify };
if (require.main === module) {
    const pool = require('../config/db');
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const expectedDatabase = args.find(argument => argument.startsWith('--expected-database='))?.slice('--expected-database='.length);
    const valid = args.every(argument => argument === '--apply' || argument.startsWith('--expected-database='));
    Promise.resolve().then(() => {
        if (!valid) throw new Error('Only --apply and --expected-database=<name> are supported');
        return migrate(pool, { apply, expectedDatabase });
    }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
