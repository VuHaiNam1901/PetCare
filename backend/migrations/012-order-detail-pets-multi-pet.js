// Targeted additive-key migration for order_detail_pets only.
// Changes PRIMARY KEY (order_detail_id) -> PRIMARY KEY (order_detail_id, pet_id)
// so one ordered product line can be linked to multiple pets (up to 10 per item).
const { createHash } = require('node:crypto');

const EXPECTED_COLUMNS = [
    'order_detail_id',
    'order_id',
    'user_id',
    'pet_id',
    'product_id',
    'pet_type_id',
    'pet_name_snapshot',
    'created_at',
];

function primaryKeyFields(indexes) {
    return indexes
        .filter(row => row.Key_name === 'PRIMARY')
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
        .map(row => row.Column_name)
        .join(',');
}

async function inspectTable(db) {
    const [[table]] = await db.execute(
        "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_detail_pets'"
    );
    if (!table || table.ENGINE !== 'InnoDB') {
        throw new Error('order_detail_pets must exist as an InnoDB table before applying migration 012');
    }

    const [columns] = await db.query('SHOW COLUMNS FROM `order_detail_pets`');
    for (const col of columns) {
        if (/(?:VIRTUAL|STORED)\s+GENERATED/i.test(String(col.Extra || ''))) {
            throw new Error(`order_detail_pets.${col.Field} must not use GENERATED columns`);
        }
    }
    for (const requiredCol of EXPECTED_COLUMNS) {
        if (!columns.some(col => col.Field === requiredCol)) {
            throw new Error(`order_detail_pets is missing required column ${requiredCol}`);
        }
    }

    const [keys] = await db.execute(
        `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE k
         WHERE k.TABLE_SCHEMA = DATABASE()
           AND k.TABLE_NAME = 'order_detail_pets'
           AND k.REFERENCED_TABLE_SCHEMA = DATABASE()`
    );
    for (const [col, parent] of [
        ['order_detail_id', 'order_details'],
        ['order_id', 'orders'],
        ['user_id', 'user'],
        ['pet_id', 'user_pets'],
        ['product_id', 'products'],
        ['pet_type_id', 'pet_types'],
    ]) {
        if (!keys.some(k => k.COLUMN_NAME === col && k.REFERENCED_TABLE_NAME === parent)) {
            throw new Error(`order_detail_pets is missing foreign key ${col} -> ${parent}`);
        }
    }

    const [indexes] = await db.query('SHOW INDEX FROM `order_detail_pets`');
    return {
        primaryKey: primaryKeyFields(indexes),
        hasTempIndex: indexes.some(row => row.Key_name === 'idx_odp_detail_tmp'),
    };
}

async function verify(db) {
    const state = await inspectTable(db);
    if (state.primaryKey !== 'order_detail_id,pet_id') {
        throw new Error(`Expected PRIMARY KEY (order_detail_id,pet_id), found (${state.primaryKey})`);
    }
    return true;
}

async function migrate(pool, { apply = false, expectedDatabase } = {}) {
    const db = await pool.getConnection();
    let lockName;
    let locked = false;
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS name');
        if (!selected?.name || (apply && (!expectedDatabase || selected.name !== expectedDatabase))) {
            throw new Error('Migration 012 apply requires the exact expected database');
        }
        if (apply) {
            lockName = 'petcare_odp_pk_' + createHash('sha256').update(selected.name).digest('hex').slice(0, 32);
            const [[lock]] = await db.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
            if (Number(lock.acquired) !== 1) throw new Error('Another migration 012 is running');
            locked = true;
        }

        const state = await inspectTable(db);
        const alreadyMultiPet = state.primaryKey === 'order_detail_id,pet_id';
        if (!alreadyMultiPet && state.primaryKey !== 'order_detail_id') {
            throw new Error(`Unexpected existing PRIMARY KEY on order_detail_pets: (${state.primaryKey})`);
        }

        if (!apply) {
            return {
                ready: alreadyMultiPet,
                requiresApply: !alreadyMultiPet,
                currentPrimaryKey: state.primaryKey,
            };
        }

        if (!alreadyMultiPet) {
            // Keep a temporary index on order_detail_id so InnoDB FK fk_odp_order_detail
            // stays backed while PRIMARY KEY transitions from (order_detail_id) to (order_detail_id, pet_id).
            if (!state.hasTempIndex) {
                await db.query('ALTER TABLE `order_detail_pets` ADD KEY `idx_odp_detail_tmp` (`order_detail_id`)');
            }
            await db.query('ALTER TABLE `order_detail_pets` DROP PRIMARY KEY, ADD PRIMARY KEY (`order_detail_id`, `pet_id`)');
            await db.query('ALTER TABLE `order_detail_pets` DROP KEY `idx_odp_detail_tmp`');
        } else if (state.hasTempIndex) {
            await db.query('ALTER TABLE `order_detail_pets` DROP KEY `idx_odp_detail_tmp`');
        }

        await verify(db);
        return {
            ready: true,
            altered: !alreadyMultiPet,
            table: 'order_detail_pets',
            primaryKey: 'order_detail_id,pet_id',
        };
    } finally {
        try {
            if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        } finally {
            db.release();
        }
    }
}

module.exports = { migrate, verify };

if (require.main === module) {
    const pool = require('../config/db');
    const args = process.argv.slice(2);
    const expected = args.filter(argument => argument.startsWith('--expected-database='));
    const valid =
        args.every(argument => argument === '--apply' || argument.startsWith('--expected-database=')) &&
        expected.length <= 1 &&
        args.filter(argument => argument === '--apply').length <= 1;

    Promise.resolve()
        .then(() => {
            if (!valid) throw new Error('Only --apply and --expected-database=<name> are supported');
            return migrate(pool, {
                apply: args.includes('--apply'),
                expectedDatabase: expected[0]?.slice('--expected-database='.length),
            });
        })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
