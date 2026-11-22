// Additive migration for Pet Profile (user_pets & order_detail_pets).
// Run without --apply for a read-only readiness plan.
// Never alters existing tables or uses GENERATED columns (keeps backup() compatible).
const { createHash } = require('node:crypto');

const TABLES = ['user_pets', 'order_detail_pets'];

const REQUIRED_COLUMNS = {
    user_pets: {
        pet_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        user_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        pet_type_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        name: { type: /^varchar\(80\)$/i, nullable: 'NO' },
        name_normalized: { type: /^varchar\(80\)$/i, nullable: 'NO' },
        breed: { type: /^varchar\(80\)$/i, nullable: 'YES' },
        age_months: { type: /^smallint(?:\(\d+\))?\s+unsigned$/i, nullable: 'YES' },
        weight_kg: { type: /^decimal\(6,2\)$/i, nullable: 'YES' },
        gender: { type: /^varchar\(20\)$/i, nullable: 'NO' },
        activity_level: { type: /^varchar\(20\)$/i, nullable: 'NO' },
        health_notes: { type: /^varchar\(300\)$/i, nullable: 'YES' },
        is_default: { type: /^tinyint(?:\(\d+\))?$/i, nullable: 'NO' },
        default_slot: { type: /^tinyint(?:\(\d+\))?$/i, nullable: 'YES' },
        deleted_at: { type: /^datetime$/i, nullable: 'YES' },
        created_at: { type: /^datetime$/i, nullable: 'NO' },
        updated_at: { type: /^datetime$/i, nullable: 'NO' },
    },
    order_detail_pets: {
        order_detail_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        order_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        user_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        pet_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        product_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        pet_type_id: { type: /^int(?:\(\d+\))?$/i, nullable: 'NO' },
        pet_name_snapshot: { type: /^varchar\(80\)$/i, nullable: 'NO' },
        created_at: { type: /^datetime$/i, nullable: 'NO' },
    },
};

const REQUIRED_FKS = {
    user_pets: [
        ['user_id', 'user', 'user_id', 'RESTRICT'],
        ['pet_type_id', 'pet_types', 'pet_type_id', 'RESTRICT'],
    ],
    order_detail_pets: [
        ['order_detail_id', 'order_details', 'order_detail_id', 'CASCADE'],
        ['order_id', 'orders', 'order_id', 'CASCADE'],
        ['user_id', 'user', 'user_id', 'RESTRICT'],
        ['pet_id', 'user_pets', 'pet_id', 'RESTRICT'],
        ['product_id', 'products', 'product_id', 'RESTRICT'],
        ['pet_type_id', 'pet_types', 'pet_type_id', 'RESTRICT'],
    ],
};

function hasIndex(indexes, fields, unique = false, keyName = null) {
    const names = [...new Set(indexes.map(row => row.Key_name))];
    return names.some(name => {
        if (keyName && name !== keyName) return false;
        const cols = indexes
            .filter(row => row.Key_name === name)
            .sort((a, b) => a.Seq_in_index - b.Seq_in_index);
        if (unique && Number(cols[0]?.Non_unique) !== 0) return false;
        return cols.map(row => row.Column_name).join(',') === fields;
    });
}

async function verifyParents(db) {
    const parents = [
        ['user', 'user_id'],
        ['pet_types', 'pet_type_id'],
        ['orders', 'order_id'],
        ['order_details', 'order_detail_id'],
        ['products', 'product_id'],
    ];
    for (const [table, pk] of parents) {
        const [[row]] = await db.execute(
            `SELECT t.ENGINE, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY
             FROM information_schema.TABLES t
             JOIN information_schema.COLUMNS c
               ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
             WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = ? AND c.COLUMN_NAME = ?`,
            [table, pk]
        );
        if (!row || row.ENGINE !== 'InnoDB' || !/^int(?:\(\d+\))?$/i.test(row.COLUMN_TYPE) || row.IS_NULLABLE !== 'NO' || row.COLUMN_KEY !== 'PRI') {
            throw new Error(`Pet profile migration requires InnoDB parent ${table}.${pk} as non-null signed INT primary key`);
        }
    }
}

async function verifyTable(db, name) {
    const [[table]] = await db.execute(
        'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [name]
    );
    if (!table || table.ENGINE !== 'InnoDB') throw new Error(`${name} must use InnoDB`);

    const [columns] = await db.query(`SHOW COLUMNS FROM \`${name}\``);
    for (const col of columns) {
        if (/(?:VIRTUAL|STORED)\s+GENERATED/i.test(String(col.Extra || ''))) {
            throw new Error(`${name}.${col.Field} must not use GENERATED columns`);
        }
    }
    for (const [field, spec] of Object.entries(REQUIRED_COLUMNS[name])) {
        const col = columns.find(item => item.Field === field);
        if (!col || col.Null !== spec.nullable || !spec.type.test(col.Type)) {
            throw new Error(`Unexpected ${name}.${field} definition`);
        }
    }

    const [indexes] = await db.query(`SHOW INDEX FROM \`${name}\``);
    if (name === 'user_pets') {
        if (
            !hasIndex(indexes, 'pet_id', true, 'PRIMARY') ||
            !hasIndex(indexes, 'user_id,default_slot', true) ||
            !hasIndex(indexes, 'user_id,deleted_at,is_default,created_at') ||
            !hasIndex(indexes, 'user_id,name_normalized,deleted_at')
        ) {
            throw new Error('user_pets is missing required primary, default unique, or lookup indexes');
        }
    } else if (name === 'order_detail_pets') {
        if (
            !hasIndex(indexes, 'order_detail_id', true, 'PRIMARY') ||
            !hasIndex(indexes, 'pet_id,user_id,created_at') ||
            !hasIndex(indexes, 'order_id') ||
            !hasIndex(indexes, 'user_id,product_id')
        ) {
            throw new Error('order_detail_pets is missing required primary or lookup indexes');
        }
    }

    const [keys] = await db.execute(
        `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_SCHEMA = DATABASE()`,
        [name]
    );
    for (const [col, parentTable, parentCol, rule] of REQUIRED_FKS[name]) {
        if (!keys.some(k => k.COLUMN_NAME === col && k.REFERENCED_TABLE_NAME === parentTable && k.REFERENCED_COLUMN_NAME === parentCol && k.DELETE_RULE === rule)) {
            throw new Error(`${name} is missing foreign key ${col} -> ${parentTable}.${parentCol} (${rule})`);
        }
    }
}

async function verify(db) {
    await verifyTable(db, 'user_pets');
    await verifyTable(db, 'order_detail_pets');
    return true;
}

async function migrate(pool, { apply = false, expectedDatabase } = {}) {
    const db = await pool.getConnection();
    let lockName;
    let locked = false;
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS name');
        if (!selected?.name || (apply && (!expectedDatabase || selected.name !== expectedDatabase))) {
            throw new Error('Pet profile apply requires the exact expected database');
        }
        if (apply) {
            lockName = 'petcare_user_pets_' + createHash('sha256').update(selected.name).digest('hex').slice(0, 32);
            const [[lock]] = await db.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
            if (Number(lock.acquired) !== 1) throw new Error('Another pet profile migration is running');
            locked = true;
        }

        await verifyParents(db);

        const [existing] = await db.execute(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user_pets', 'order_detail_pets')"
        );
        const present = new Set(existing.map(row => row.TABLE_NAME));
        for (const table of present) await verifyTable(db, table);

        if (!apply) {
            return {
                ready: present.size === TABLES.length,
                requiresApply: present.size !== TABLES.length,
                existingTables: TABLES.filter(name => present.has(name)),
            };
        }

        if (!present.has('user_pets')) {
            await db.query(`
                CREATE TABLE user_pets (
                    pet_id INT NOT NULL AUTO_INCREMENT,
                    user_id INT NOT NULL,
                    pet_type_id INT NOT NULL,
                    name VARCHAR(80) NOT NULL,
                    name_normalized VARCHAR(80) NOT NULL,
                    breed VARCHAR(80) NULL DEFAULT NULL,
                    age_months SMALLINT UNSIGNED NULL DEFAULT NULL,
                    weight_kg DECIMAL(6,2) NULL DEFAULT NULL,
                    gender VARCHAR(20) NOT NULL DEFAULT 'unknown',
                    activity_level VARCHAR(20) NOT NULL DEFAULT 'medium',
                    health_notes VARCHAR(300) NULL DEFAULT NULL,
                    is_default TINYINT(1) NOT NULL DEFAULT 0,
                    default_slot TINYINT NULL DEFAULT NULL,
                    deleted_at DATETIME NULL DEFAULT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (pet_id),
                    UNIQUE KEY uq_user_pet_default (user_id, default_slot),
                    KEY idx_user_pet_active (user_id, deleted_at, is_default, created_at),
                    KEY idx_user_pet_name (user_id, name_normalized, deleted_at),
                    KEY idx_user_pet_type (pet_type_id),
                    CONSTRAINT fk_user_pet_user FOREIGN KEY (user_id) REFERENCES user (user_id) ON DELETE RESTRICT,
                    CONSTRAINT fk_user_pet_type FOREIGN KEY (pet_type_id) REFERENCES pet_types (pet_type_id) ON DELETE RESTRICT,
                    CONSTRAINT chk_user_pet_default CHECK (
                        is_default IN (0, 1)
                        AND ((default_slot IS NULL AND is_default = 0) OR (default_slot = 1 AND is_default = 1 AND deleted_at IS NULL))
                    )
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        }

        if (!present.has('order_detail_pets')) {
            await db.query(`
                CREATE TABLE order_detail_pets (
                    order_detail_id INT NOT NULL,
                    order_id INT NOT NULL,
                    user_id INT NOT NULL,
                    pet_id INT NOT NULL,
                    product_id INT NOT NULL,
                    pet_type_id INT NOT NULL,
                    pet_name_snapshot VARCHAR(80) NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (order_detail_id),
                    KEY idx_order_detail_pets_pet_user (pet_id, user_id, created_at),
                    KEY idx_order_detail_pets_order (order_id),
                    KEY idx_order_detail_pets_user_product (user_id, product_id),
                    CONSTRAINT fk_odp_order_detail FOREIGN KEY (order_detail_id) REFERENCES order_details (order_detail_id) ON DELETE CASCADE,
                    CONSTRAINT fk_odp_order FOREIGN KEY (order_id) REFERENCES orders (order_id) ON DELETE CASCADE,
                    CONSTRAINT fk_odp_user FOREIGN KEY (user_id) REFERENCES user (user_id) ON DELETE RESTRICT,
                    CONSTRAINT fk_odp_pet FOREIGN KEY (pet_id) REFERENCES user_pets (pet_id) ON DELETE RESTRICT,
                    CONSTRAINT fk_odp_product FOREIGN KEY (product_id) REFERENCES products (product_id) ON DELETE RESTRICT,
                    CONSTRAINT fk_odp_pet_type FOREIGN KEY (pet_type_id) REFERENCES pet_types (pet_type_id) ON DELETE RESTRICT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        }

        await verify(db);
        return {
            ready: true,
            created: present.size !== TABLES.length,
            additiveOnly: true,
        };
    } finally {
        try {
            if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        } finally {
            db.release();
        }
    }
}

module.exports = { migrate, verify, TABLES };

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
