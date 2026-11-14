// Additive classification only. Run without --apply for a read-only plan.
// No existing products/categories, stock, or financial records are modified.
const { createHash } = require('node:crypto');
const types = [
    [1, 'dog', 'Chó'], [2, 'cat', 'Mèo'], [3, 'bird', 'Chim'],
    [4, 'fish', 'Cá'], [5, 'hamster', 'Hamster/Chuột'], [6, 'rabbit', 'Thỏ'],
];

// Reviewed from explicit species in the current name/description, never from
// category names. SHA256(name + NUL + description) prevents stale ID guesses.
// Ambiguous products 8,12,14,17,18 deliberately have no initial assignment.
const initialProducts = [
    [1, [2], '5c086b19ea44204326d534650c26fa853613489d658240486c587fda9792bbe5'],
    [2, [2], 'bf268f41b64b9a64e3b482be25325a030ee388e99c02e5ba6d8958f5f7823483'],
    [3, [2], 'c7212e06c49e345f2e0a21ee7b0282c4e45eb64371061f8c6473e2c9ca12e3fa'],
    [4, [2], '60ccb9e1dc1a1f273c7812b795a5250b18b5c6f4bfe645f62ef4284dd0503953'],
    [5, [1], '790906925ff9a6c96687271ba422bfa1fd4776f74efc37e9c32eb2a4a5faf21f'],
    [6, [1, 2], 'ee036c0780421dc6b2b4a5c07e12c0b9376cdd48a192ac654f0863bd4f9fa730'],
    [7, [1], 'f70670be9225b4d3bc5f0c8fa1269f66ed9a3fcdc66927c23f4bcca9a293a846'],
    [9, [2], 'c9e4e308d0f333f87d0eeb78bb16606d0a595a5787efcf99d2991485681feb92'],
    [10, [2], '2d7c5cf152f786cfc7945b4308e50eee1c1d278031cd0f84a9986eccd3ac6bfc'],
    [11, [1], '121ae90259bc5800f8abeefb6f9ef544f614e5d203263bad25b568683f1599f0'],
    [13, [1], '4f268fdc19250d730668e87b890ceb6d155f223e2c408e00014f0f136eb640f7'],
    [15, [2], '050d1a2d78c0cefc9157e9436dea74bb3dde490777aa6064b00847fdba8eaea1'],
    [16, [2], 'ca53304f8d1a1efbbfc6906119df64efc0a8b963212f1368eb76d8ce0a112644'],
    [19, [1], '1406e30c0399b4cf0c2094aa029db69c11e4d4dccf275c25af00e55266f7a022'],
    [20, [2], '69009bf175cc09ba03974e6dea1c069726af1675e69aeae4f5729bdab0fae911'],
    [21, [1], '071e0940de918f3801de011fde91d241078a16033ba4d01368726cf58608fc8a'],
];
const sourceHash = product => createHash('sha256').update(`${product.name}\0${product.description ?? ''}`).digest('hex');

async function verifyTable(db, name) {
    const [[table]] = await db.execute('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name]);
    if (!table || table.ENGINE !== 'InnoDB') throw new Error(`${name} must use InnoDB`);
    const [columns] = await db.query(`SHOW COLUMNS FROM \`${name}\``);
    const required = name === 'pet_types' ? { pet_type_id: /^int(?:\(\d+\))?$/i, slug: /^varchar\(20\)$/i, name: /^varchar\(50\)$/i }
        : { product_id: /^int(?:\(\d+\))?$/i, pet_type_id: /^int(?:\(\d+\))?$/i };
    for (const [field, pattern] of Object.entries(required)) {
        const column = columns.find(column => column.Field === field);
        if (!column || column.Null !== 'NO' || !pattern.test(column.Type)) throw new Error(`Unexpected ${name}.${field} definition`);
    }
    const [indexes] = await db.query(`SHOW INDEX FROM \`${name}\``);
    const hasIndex = (fields, unique, keyName) => indexes.some(index => (!keyName || index.Key_name === keyName) && (!unique || Number(index.Non_unique) === 0) &&
        indexes.filter(other => other.Key_name === index.Key_name).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(other => other.Column_name).join(',') === fields);
    if (name === 'pet_types') {
        if (!hasIndex('pet_type_id', true, 'PRIMARY') || !hasIndex('slug', true) || !hasIndex('name', true)) throw new Error('Pet types require primary and unique name/slug keys');
    } else {
        if (!hasIndex('product_id,pet_type_id', true, 'PRIMARY') || !hasIndex('pet_type_id,product_id')) throw new Error('Product pet types require both lookup directions and a unique product/type key');
        const [keys] = await db.execute(`SELECT k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='product_pet_types' AND k.REFERENCED_TABLE_SCHEMA=DATABASE()`);
        for (const [column, parent, rule] of [['product_id', 'products', 'CASCADE'], ['pet_type_id', 'pet_types', 'RESTRICT']]) {
            if (!keys.some(key => key.COLUMN_NAME === column && key.REFERENCED_TABLE_NAME === parent && key.REFERENCED_COLUMN_NAME === column && key.DELETE_RULE === rule)) throw new Error('Product pet types require their product/type foreign keys');
        }
    }
}
async function verify(db) {
    await verifyTable(db, 'pet_types');
    await verifyTable(db, 'product_pet_types');
    const [rows] = await db.execute('SELECT pet_type_id,slug,name FROM pet_types ORDER BY pet_type_id');
    if (rows.length && (rows.length !== types.length || !types.every(([id, slug, name]) => rows.some(row => row.pet_type_id === id && row.slug === slug && row.name === name)))) {
        throw new Error('Existing pet types differ from the six reference groups; no data was overwritten');
    }
    return rows.length === types.length;
}

async function migrate(pool, { apply = false, expectedDatabase } = {}) {
    const db = await pool.getConnection();
    let lockName, locked = false;
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS name');
        if (!selected.name || (apply && (!expectedDatabase || selected.name !== expectedDatabase))) throw new Error('Pet type apply requires the exact expected database');
        if (apply) {
            lockName = 'petcare_pet_types_' + createHash('sha256').update(selected.name).digest('hex').slice(0, 32);
            const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
            if (Number(lock.acquired) !== 1) throw new Error('Another pet type migration is running');
            locked = true;
        }
        const [[parent]] = await db.execute("SELECT t.ENGINE,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_KEY FROM information_schema.TABLES t JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='products' AND c.COLUMN_NAME='product_id'");
        if (!parent || parent.ENGINE !== 'InnoDB' || !/^int(?:\(\d+\))?$/i.test(parent.COLUMN_TYPE) || parent.IS_NULLABLE !== 'NO' || parent.COLUMN_KEY !== 'PRI') throw new Error('Pet types require existing InnoDB products with signed integer primary IDs');
        const [existing] = await db.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('pet_types','product_pet_types')");
        const present = new Set(existing.map(table => table.TABLE_NAME));
        for (const name of present) await verifyTable(db, name);
        let referenceReady = false;
        if (present.has('pet_types')) {
            const [rows] = await db.execute('SELECT pet_type_id,slug,name FROM pet_types ORDER BY pet_type_id');
            if (rows.length && (rows.length !== types.length || !types.every(([id, slug, name]) => rows.some(row => row.pet_type_id === id && row.slug === slug && row.name === name)))) throw new Error('Existing pet types differ from the six reference groups; no data was overwritten');
            referenceReady = rows.length === types.length;
        }
        const [products] = await db.execute('SELECT product_id,name,description FROM products ORDER BY product_id');
        const matches = initialProducts.filter(([id, , digest]) => products.some(product => product.product_id === id && sourceHash(product) === digest));
        if (!apply) return { ready: present.size === 2 && referenceReady, requiresApply: present.size !== 2 || !referenceReady,
            products: products.length, identified: matches.length, unresolved: products.length - matches.length, plannedLinks: matches.reduce((sum, [, ids]) => sum + ids.length, 0) };
        if (!present.has('pet_types')) await db.query(`CREATE TABLE pet_types (
            pet_type_id INT NOT NULL,
            slug VARCHAR(20) NOT NULL,
            name VARCHAR(50) NOT NULL,
            PRIMARY KEY (pet_type_id),
            UNIQUE KEY uq_pet_type_slug (slug),
            UNIQUE KEY uq_pet_type_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        if (!present.has('product_pet_types')) await db.query(`CREATE TABLE product_pet_types (
            product_id INT NOT NULL,
            pet_type_id INT NOT NULL,
            PRIMARY KEY (product_id,pet_type_id),
            KEY idx_pet_type_product (pet_type_id,product_id),
            CONSTRAINT fk_product_pet_type_product FOREIGN KEY (product_id) REFERENCES products (product_id) ON DELETE CASCADE,
            CONSTRAINT fk_product_pet_type_type FOREIGN KEY (pet_type_id) REFERENCES pet_types (pet_type_id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        referenceReady = await verify(db);
        // Reference rows and initial links are committed together. Existing
        // reference rows mark a completed initialization: reruns never restore
        // assignments that an Admin has subsequently changed or cleared.
        let assignedProducts = 0, assignedLinks = 0;
        if (!referenceReady) {
            await db.beginTransaction();
            try {
                await db.query('INSERT INTO pet_types (pet_type_id,slug,name) VALUES ?', [types]);
                for (const [id, ids, digest] of matches) {
                    const [[product]] = await db.execute('SELECT product_id,name,description FROM products WHERE product_id=? FOR UPDATE', [id]);
                    if (!product || sourceHash(product) !== digest) continue;
                    const [links] = await db.execute('SELECT pet_type_id FROM product_pet_types WHERE product_id=? FOR UPDATE', [id]);
                    if (links.length) continue;
                    await db.query('INSERT INTO product_pet_types (product_id,pet_type_id) VALUES ?', [ids.map(typeId => [id, typeId])]);
                    assignedProducts++; assignedLinks += ids.length;
                }
                await db.commit();
            } catch (error) { await db.rollback(); throw error; }
        }
        await verify(db);
        return { ready: true, created: present.size !== 2, assignedProducts, assignedLinks, additiveOnly: true };
    } finally {
        try { if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
        finally { db.release(); }
    }
}

module.exports = { migrate, verify };
if (require.main === module) {
    const pool = require('../config/db');
    const args = process.argv.slice(2);
    const expected = args.filter(argument => argument.startsWith('--expected-database='));
    const valid = args.every(argument => argument === '--apply' || argument.startsWith('--expected-database=')) && expected.length <= 1 && args.filter(argument => argument === '--apply').length <= 1;
    Promise.resolve().then(() => {
        if (!valid) throw new Error('Only --apply and --expected-database=<name> are supported');
        return migrate(pool, { apply: args.includes('--apply'), expectedDatabase: expected[0]?.slice('--expected-database='.length) });
    }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
