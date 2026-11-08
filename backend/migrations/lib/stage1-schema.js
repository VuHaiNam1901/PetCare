'use strict';

// Migration 006+ deliberately does not import or replay historical migrations.
// Loading this module never opens MySQL. MySQL DDL is not transactionally
// rollbackable: inspect every existing object, journal progress, and resume only
// missing additive steps after an interrupted run.
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const identifier = value => '`' + String(value).replace(/`/g, '``') + '`';
const digest = value => createHash('sha256').update(value).digest('hex');
const sqlString = value => "'" + String(value).replace(/'/g, "''") + "'";
const normalizeType = value => String(value).toLowerCase().replace(/\b(integer)\b/g, 'int').replace(/\s+/g, ' ').trim();
// InnoDB implements NO ACTION as the same immediate restriction as RESTRICT.
const normalizeRule = value => value === 'NO ACTION' ? 'RESTRICT' : value;

// CHECK_CLAUSE adds parentheses, backticks and character-set introducers. Parse
// the small expression grammar used by these migrations rather than deleting
// parentheses/lowercasing strings: either operation could hide a changed rule.
function canonicalCheck(expression) {
    const input = String(expression), tokens = [];
    let cursor = 0;
    while (cursor < input.length) {
        if (/\s/.test(input[cursor])) { cursor++; continue; }
        const rest = input.slice(cursor);
        if (input[cursor] === "'" || input.startsWith("\\'", cursor)) {
            // INFORMATION_SCHEMA.CHECK_CONSTRAINTS on MySQL 8.0 can escape the
            // SQL literal delimiters themselves (e.g. _utf8mb4\'pending\').
            // Recognize that delimiter locally; never strip backslashes from
            // the whole expression or from the content of other literals.
            const delimiter = input[cursor] === "'" ? "'" : "\\'";
            cursor += delimiter.length;
            let value = '', closed = false;
            while (cursor < input.length) {
                if (input.startsWith(delimiter, cursor)) {
                    cursor += delimiter.length;
                    if (input.startsWith(delimiter, cursor)) { value += "'"; cursor += delimiter.length; }
                    else { closed = true; break; }
                    continue;
                }
                const next = input[cursor++];
                if (next === '\\') {
                    if (cursor >= input.length) throw new Error('Invalid CHECK string escape');
                    const escaped = input[cursor++];
                    value += ({ '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' })[escaped] ?? escaped;
                } else value += next;
            }
            if (!closed) throw new Error('Unterminated CHECK string');
            let charset = null;
            if (tokens.at(-1)?.kind === 'identifier' && /^_[a-z0-9]+$/.test(tokens.at(-1).value)) charset = tokens.pop().value;
            if (/^[\x00-\x7f]*$/.test(value) && ['_ascii', '_utf8mb4', '_utf8mb3', '_utf8'].includes(charset)) charset = null;
            tokens.push({ kind: 'string', value, charset });
            continue;
        }
        if (input[cursor] === '`') {
            const match = /^`((?:``|[^`])*)`/.exec(rest);
            if (!match) throw new Error('Invalid CHECK identifier');
            tokens.push({ kind: 'identifier', value: match[1].replace(/``/g, '`').toLowerCase() }); cursor += match[0].length; continue;
        }
        const word = /^[a-z_][a-z0-9_]*/i.exec(rest);
        if (word) { tokens.push({ kind: 'identifier', value: word[0].toLowerCase() }); cursor += word[0].length; continue; }
        const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
        if (number) { tokens.push({ kind: 'number', value: number[0] }); cursor += number[0].length; continue; }
        const operator = /^(?:<>|!=|<=|>=|[=<>(),+\-])/.exec(rest);
        if (!operator) throw new Error('Unsupported CHECK expression token');
        tokens.push({ kind: 'symbol', value: operator[0] === '!=' ? '<>' : operator[0] }); cursor += operator[0].length;
    }
    let position = 0;
    const peek = value => tokens[position]?.value === value;
    const take = value => { if (!peek(value)) throw new Error(`Invalid CHECK expression: expected ${value}`); position++; };
    function primary() {
        if (peek('(')) { position++; const value = disjunction(); take(')'); return value; }
        const token = tokens[position++];
        if (!token) throw new Error('Incomplete CHECK expression');
        if (token.kind === 'identifier' && peek('(')) {
            position++;
            const args = [];
            if (!peek(')')) { do { args.push(disjunction()); if (!peek(',')) break; position++; } while (true); }
            take(')'); return ['call', token.value, ...args];
        }
        if (token.kind === 'string') return ['string', token.value, token.charset];
        if (token.kind === 'number' || token.kind === 'identifier') return [token.kind, token.value];
        throw new Error('Invalid CHECK operand');
    }
    function comparison() {
        let left = primary();
        if (peek('is')) {
            position++; const negated = peek('not'); if (negated) position++; take('null');
            return [negated ? 'is-not-null' : 'is-null', left];
        }
        if (peek('in') || (peek('not') && tokens[position + 1]?.value === 'in')) {
            const negated = peek('not'); if (negated) position++; take('in'); take('(');
            const values = [];
            do { values.push(primary()); if (!peek(',')) break; position++; } while (true);
            take(')'); return [negated ? 'not-in' : 'in', left, ...values];
        }
        if (['=', '<>', '<', '>', '<=', '>='].includes(tokens[position]?.value)) {
            const operator = tokens[position++].value;
            left = [operator, left, primary()];
        }
        return left;
    }
    function unary() { if (peek('not')) { position++; return ['not', unary()]; } return comparison(); }
    function conjunction() { let value = unary(); while (peek('and')) { position++; value = ['and', value, unary()]; } return value; }
    function disjunction() { let value = conjunction(); while (peek('or')) { position++; value = ['or', value, conjunction()]; } return value; }
    const tree = disjunction();
    if (position !== tokens.length) throw new Error('Unsupported trailing CHECK expression');
    return JSON.stringify(tree);
}

function column(type, options = {}) {
    const { nullable = false, collation = null, autoIncrement = false, defaultValue = null, defaultExpression = null } = options;
    const charset = collation ? collation.split('_')[0] : null;
    return {
        type: normalizeType(type), nullable, collation, autoIncrement, defaultValue, defaultExpression,
        sql: `${type.toUpperCase()}${charset ? ` CHARACTER SET ${charset} COLLATE ${collation}` : ''}` +
            (nullable ? ' NULL' : ' NOT NULL') +
            (defaultExpression ? ` DEFAULT ${defaultExpression}` : defaultValue !== null ? ` DEFAULT ${sqlString(defaultValue)}` : nullable ? ' DEFAULT NULL' : '') +
            (autoIncrement ? ' AUTO_INCREMENT' : '')
    };
}
const ascii = (type, nullable = false) => column(type, { nullable, collation: 'ascii_bin' });
const unicode = (type, nullable = false) => column(type, { nullable, collation: 'utf8mb4_unicode_ci' });
const idx = (name, columns, unique = false) => ({ name, columns, unique });
const fk = (name, columns, table, referencedColumns, onDelete = 'RESTRICT') => ({ name, columns, table, referencedColumns, onDelete, onUpdate: 'RESTRICT' });

const ledger = {
    table: 'schema_migrations', kind: 'create',
    columns: {
        version: ascii('char(3)'), name: ascii('varchar(96)'), checksum: ascii('char(64)'),
        status: ascii('varchar(16)'), step: ascii('varchar(128)', true),
        started_at_utc: column('datetime(3)'), updated_at_utc: column('datetime(3)'),
        completed_at_utc: column('datetime(3)', { nullable: true })
    },
    indexes: [idx('PRIMARY', ['version'], true)], foreignKeys: [], checks: []
};

async function readTable(db, table) {
    const [[metadata]] = await db.execute(`SELECT TABLE_TYPE AS table_type, ENGINE AS engine, TABLE_COLLATION AS collation,
        TABLE_SCHEMA AS schema_name
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [table]);
    if (!metadata) return null;
    const [columns] = await db.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS default_value, COLLATION_NAME AS collation, EXTRA AS extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [table]);
    const [indexes] = await db.query('SHOW INDEX FROM ' + identifier(table));
    const [foreignKeys] = await db.execute(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name,
        k.REFERENCED_TABLE_SCHEMA AS referenced_schema, k.REFERENCED_TABLE_NAME AS referenced_table, k.REFERENCED_COLUMN_NAME AS referenced_column,
        k.ORDINAL_POSITION AS position, r.DELETE_RULE AS delete_rule, r.UPDATE_RULE AS update_rule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [table]);
    const [checks] = await db.execute(`SELECT t.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS expression, t.ENFORCED AS enforced
        FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
          ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK'`, [table]);
    return { ...metadata, columns, indexes, foreignKeys, checks };
}

function assertColumn(table, name, expected, actual) {
    const validDefault = expected.defaultExpression ? String(actual.default_value).toLowerCase() === expected.defaultExpression.toLowerCase() : actual.default_value === expected.defaultValue;
    const extra = expected.autoIncrement ? 'auto_increment' : expected.defaultExpression ? 'default_generated' : '';
    if (normalizeType(actual.type) !== expected.type || (actual.nullable === 'YES') !== expected.nullable ||
        !validDefault || actual.collation !== expected.collation || String(actual.extra || '').toLowerCase() !== extra) {
        throw new Error(`Schema drift: ${table}.${name} has an unexpected type/null/default/collation/extra definition`);
    }
}

function sameIndex(actual, expected) {
    const entries = actual.filter(row => row.Key_name === expected.name).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
    if (!entries.length) return false;
    if (entries.length !== expected.columns.length || entries.some((entry, i) => entry.Column_name !== expected.columns[i] ||
        Boolean(Number(entry.Non_unique)) === expected.unique || entry.Sub_part !== null || entry.Index_type !== 'BTREE' ||
        (entry.Visible !== undefined && entry.Visible !== 'YES') || entry.Expression)) {
        throw new Error(`Schema drift: index ${expected.name} has an unexpected definition`);
    }
    return true;
}

function assertForeignKey(table, expected, rows, expectedSchema) {
    const actual = rows.filter(row => row.name === expected.name).sort((a, b) => Number(a.position) - Number(b.position));
    if (actual.length !== expected.columns.length || actual.some((row, i) => row.column_name !== expected.columns[i] ||
        row.referenced_schema !== expectedSchema || row.referenced_table !== expected.table || row.referenced_column !== expected.referencedColumns[i] ||
        normalizeRule(row.delete_rule) !== normalizeRule(expected.onDelete) || normalizeRule(row.update_rule) !== normalizeRule(expected.onUpdate))) {
        throw new Error(`Schema drift: foreign key ${table}.${expected.name} is missing or different`);
    }
}

async function inspectObject(db, spec, { required = false } = {}) {
    const actual = await readTable(db, spec.table);
    if (!actual) {
        if (required || spec.kind !== 'create') throw new Error(`Required baseline table ${spec.table} is missing`);
        return [{ kind: 'create', spec, key: `create:${spec.table}` }];
    }
    if (actual.table_type !== 'BASE TABLE' || actual.engine !== 'InnoDB') throw new Error(`Unsupported engine/object: ${spec.table}`);
    // A same-named referenced table in another database is not the reviewed
    // dependency. The metadata query is scoped to DATABASE(), and every FK must
    // point back to that exact schema. Missing metadata must fail closed.
    if (typeof actual.schema_name !== 'string' || !actual.schema_name) throw new Error(`Schema drift: missing database metadata for ${spec.table}`);
    if (spec.kind === 'create' && actual.collation !== 'utf8mb4_unicode_ci') throw new Error(`Schema drift: table collation ${spec.table}`);
    const existing = new Map(actual.columns.map(item => [item.name, item]));
    const pending = [];
    for (const [name, definition] of Object.entries(spec.columns)) {
        if (existing.has(name)) assertColumn(spec.table, name, definition, existing.get(name));
        else if (required || spec.kind === 'create') throw new Error(`Partial or incompatible table ${spec.table}: missing ${name}; manual review required`);
        else pending.push({ kind: 'column', spec, name, definition, key: `column:${spec.table}.${name}` });
    }
    if (spec.kind === 'create' && actual.columns.length !== Object.keys(spec.columns).length) throw new Error(`Schema drift: unexpected columns in ${spec.table}`);
    if (spec.kind === 'create' && new Set(actual.indexes.map(item => item.Key_name)).size !== (spec.indexes || []).length) throw new Error(`Schema drift: unexpected indexes in ${spec.table}`);
    if (spec.kind === 'create' && new Set(actual.foreignKeys.map(item => item.name)).size !== (spec.foreignKeys || []).length) throw new Error(`Schema drift: unexpected foreign keys in ${spec.table}`);
    if (spec.kind === 'create' && actual.checks.length !== (spec.checks || []).length) throw new Error(`Schema drift: unexpected checks in ${spec.table}`);
    for (const index of spec.indexes || []) {
        if (!sameIndex(actual.indexes, index)) {
            if (required || spec.kind === 'create') throw new Error(`Partial or incompatible table ${spec.table}: missing index ${index.name}`);
            pending.push({ kind: 'index', spec, index, key: `index:${spec.table}.${index.name}` });
        }
    }
    for (const foreignKey of spec.foreignKeys || []) assertForeignKey(spec.table, foreignKey, actual.foreignKeys, actual.schema_name);
    for (const check of spec.checks || []) {
        const saved = actual.checks.find(item => item.name === check.name);
        if (!saved || saved.enforced !== 'YES' || canonicalCheck(saved.expression) !== canonicalCheck(check.expression)) {
            throw new Error(`Schema drift: check constraint ${spec.table}.${check.name} is missing or different`);
        }
    }
    return pending;
}

function indexSql(index) {
    return `${index.name === 'PRIMARY' ? 'PRIMARY KEY' : `${index.unique ? 'UNIQUE ' : ''}KEY ${identifier(index.name)}`} (${index.columns.map(identifier).join(',')})`;
}
function createSql(spec) {
    const definitions = Object.entries(spec.columns).map(([name, definition]) => `${identifier(name)} ${definition.sql}`);
    definitions.push(...(spec.indexes || []).map(indexSql));
    definitions.push(...(spec.foreignKeys || []).map(ref => `CONSTRAINT ${identifier(ref.name)} FOREIGN KEY (${ref.columns.map(identifier).join(',')}) REFERENCES ${identifier(ref.table)} (${ref.referencedColumns.map(identifier).join(',')}) ON DELETE ${ref.onDelete} ON UPDATE ${ref.onUpdate}`));
    definitions.push(...(spec.checks || []).map(check => `CONSTRAINT ${identifier(check.name)} CHECK (${check.expression})`));
    return `CREATE TABLE ${identifier(spec.table)} (${definitions.join(',\n')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}
function stepSql(step) {
    if (step.kind === 'create') return createSql(step.spec);
    if (step.kind === 'column') return `ALTER TABLE ${identifier(step.spec.table)} ADD COLUMN ${identifier(step.name)} ${step.definition.sql}`;
    return `ALTER TABLE ${identifier(step.spec.table)} ADD ${indexSql(step.index)}`;
}

function checksum(plan) {
    return digest(JSON.stringify({ version: plan.version, name: plan.name, objects: plan.objects, baseline: plan.baseline }) +
        fs.readFileSync(plan.sourceFile, 'utf8') + fs.readFileSync(__filename, 'utf8'));
}

async function inspectPlan(db, plan) {
    for (const baseline of plan.baseline || []) await inspectObject(db, baseline, { required: true });
    const pending = [];
    for (const object of plan.objects) pending.push(...await inspectObject(db, object));
    return pending;
}

async function prerequisite(db, plan, existingLedger) {
    for (const dependency of plan.dependencies || []) {
        if (!existingLedger) throw new Error(`Migration ${plan.version} requires completed migration ${dependency.version}`);
        const [[entry]] = await db.execute('SELECT version,checksum,status FROM schema_migrations WHERE version=?', [dependency.version]);
        if (!entry || entry.status !== 'completed' || entry.checksum !== checksum(dependency) || (await inspectPlan(db, dependency)).length) {
            throw new Error(`Migration ${plan.version} prerequisite ${dependency.version} is missing, changed or incomplete`);
        }
        await prerequisite(db, dependency, true);
    }
}

async function preflight(db, plan) {
    const [[environment]] = await db.query('SELECT DATABASE() AS database_name, VERSION() AS server_version, @@SESSION.sql_mode AS sql_mode');
    if (!environment.database_name || /NO_BACKSLASH_ESCAPES/.test(environment.sql_mode)) throw new Error('Select a database with standard SQL escaping');
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(environment.server_version || '');
    if (!version || /mariadb/i.test(environment.server_version) || Number(version[1]) < 8 ||
        (Number(version[1]) === 8 && Number(version[2]) === 0 && Number(version[3]) < 16)) throw new Error('Migration requires MySQL >=8.0.16 with enforced CHECK constraints');
    const [objects] = await db.query(`SELECT TABLE_NAME AS name,TABLE_TYPE AS type,ENGINE AS engine
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`);
    if (objects.some(object => object.type !== 'BASE TABLE' || object.engine !== 'InnoDB')) throw new Error('Only InnoDB base tables are supported');
    const [[stored]] = await db.query(`SELECT
        (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) AS triggers_count,
        (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) AS routines_count,
        (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) AS events_count`);
    if (Number(stored.triggers_count) || Number(stored.routines_count) || Number(stored.events_count)) throw new Error('Stored database objects require a separately reviewed migration');
    const actualLedger = await readTable(db, ledger.table);
    if (actualLedger) await inspectObject(db, ledger, { required: true });
    await prerequisite(db, plan, Boolean(actualLedger));
    let entry;
    if (actualLedger) [[entry]] = await db.execute('SELECT version,name,checksum,status,step FROM schema_migrations WHERE version=?', [plan.version]);
    if (entry && (entry.checksum !== checksum(plan) || entry.name !== plan.name || !['running', 'failed', 'completed'].includes(entry.status))) throw new Error(`Migration ${plan.version} ledger checksum/name/status mismatch`);
    const pending = await inspectPlan(db, plan);
    if (entry?.status === 'completed' && pending.length) throw new Error(`Completed migration ${plan.version} has schema drift`);
    return { environment, objects, actualLedger, entry, pending };
}

function assertApplyTarget(database, options) {
    if (options.expectedDatabase !== database) throw new Error('Apply requires expectedDatabase matching SELECT DATABASE() exactly');
    const isolated = options.isolatedTest === true && process.env.NODE_ENV === 'test' && /^petcare_test_[a-f0-9]{32}$/.test(database) &&
        process.env.PETCARE_TEST_DATABASE === database && process.env.DB_NAME === database &&
        process.env.PETCARE_TEST_ISOLATED === '1' && Boolean(process.env.PETCARE_TEST_SOURCE_DATABASE) && process.env.PETCARE_TEST_SOURCE_DATABASE !== database;
    if (!isolated && !(options.allowApplicationDatabase === true && typeof options.assertWritersStopped === 'function' && typeof options.verifyBackup === 'function')) {
        throw new Error('Application apply requires explicit authorization, stopped-writer verification and verified backup callbacks; isolated tests require the guarded generated test schema');
    }
    return isolated;
}

async function snapshot(db, objects) {
    const saved = [];
    for (const object of objects.filter(item => item.name !== ledger.table)) {
        const metadata = await readTable(db, object.name);
        const columns = metadata.columns.map(item => item.name);
        const [rows] = await db.query(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(object.name)}`);
        saved.push({ table: object.name, columns, count: rows.length, hash: digest(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())) });
    }
    return saved;
}
async function verifySnapshot(db, saved) {
    for (const item of saved) {
        const [rows] = await db.query(`SELECT ${item.columns.map(identifier).join(',')} FROM ${identifier(item.table)}`);
        if (rows.length !== item.count || digest(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())) !== item.hash) throw new Error(`Existing data changed in ${item.table}; keep writers stopped and inspect backup`);
    }
}

async function migrate(pool, plan, options = {}) {
    const db = await pool.getConnection();
    let acquired = false, lockName, journalStarted = false;
    try {
        let inspection = await preflight(db, plan);
        if (options.apply !== true) return { version: plan.version, dryRun: true, checksum: checksum(plan), pendingSteps: inspection.pending.map(step => ({ key: step.key, sql: stepSql(step) })), completed: inspection.entry?.status === 'completed' };
        const isolated = assertApplyTarget(inspection.environment.database_name, options);
        lockName = 'petcare_stage1_' + digest(inspection.environment.database_name).slice(0, 32);
        const [[lock]] = await db.query('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another stage 1 migration is running');
        acquired = true;
        inspection = await preflight(db, plan);
        if (inspection.entry?.status === 'completed') return { version: plan.version, dryRun: false, completed: true, schemaChanges: 0, existingDataUnchanged: true };
        const assertStopped = async () => { if (!isolated) await options.assertWritersStopped({ db, database: inspection.environment.database_name, version: plan.version }); };
        await assertStopped();
        if (!isolated) await options.verifyBackup({ db, database: inspection.environment.database_name, version: plan.version });
        await assertStopped();
        const before = await snapshot(db, inspection.objects);
        if (!inspection.actualLedger) await db.query(createSql(ledger));
        await db.execute(`INSERT INTO schema_migrations (version,name,checksum,status,step,started_at_utc,updated_at_utc,completed_at_utc)
            VALUES (?,?,?,'running',NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),NULL)
            ON DUPLICATE KEY UPDATE status='running',updated_at_utc=UTC_TIMESTAMP(3),completed_at_utc=NULL`, [plan.version, plan.name, checksum(plan)]);
        journalStarted = true;
        for (const step of inspection.pending) {
            await assertStopped();
            await db.execute('UPDATE schema_migrations SET step=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE version=?', [step.key, plan.version]);
            await db.query(stepSql(step));
        }
        if ((await inspectPlan(db, plan)).length) throw new Error(`Migration ${plan.version} verification found missing schema`);
        await assertStopped();
        await verifySnapshot(db, before);
        await db.execute("UPDATE schema_migrations SET status='completed',step=NULL,updated_at_utc=UTC_TIMESTAMP(3),completed_at_utc=UTC_TIMESTAMP(3) WHERE version=?", [plan.version]);
        return { version: plan.version, dryRun: false, completed: true, schemaChanges: inspection.pending.length, existingDataUnchanged: true, preservedTables: before.map(item => ({ table: item.table, count: item.count, hash: item.hash })) };
    } catch (error) {
        if (journalStarted) {
            try { await db.execute("UPDATE schema_migrations SET status='failed',updated_at_utc=UTC_TIMESTAMP(3) WHERE version=?", [plan.version]); } catch { /* Preserve the original failure and phase for operator review. */ }
        }
        throw error;
    } finally {
        try { if (acquired) await db.query('SELECT RELEASE_LOCK(?)', [lockName]); }
        finally { db.release(); }
    }
}

async function verify(db, plan) {
    await inspectObject(db, ledger, { required: true });
    await prerequisite(db, plan, true);
    const [[entry]] = await db.execute('SELECT version,name,checksum,status FROM schema_migrations WHERE version=?', [plan.version]);
    if (!entry || entry.status !== 'completed' || entry.name !== plan.name || entry.checksum !== checksum(plan) || (await inspectPlan(db, plan)).length) throw new Error(`Migration ${plan.version} is incomplete or schema/checksum differs`);
    return { version: plan.version, verified: true };
}

function cli(plan) {
    // CLI is inspection only. Applying to an application DB is intentionally an
    // operational API with required verification hooks, never a convenient flag.
    if (process.argv.slice(2).some(argument => argument !== '--dry-run')) {
        console.error('Only --dry-run is supported. Apply requires the reviewed migration API and safety callbacks.');
        process.exitCode = 1;
        return;
    }
    const pool = require('../../config/db');
    migrate(pool, plan).then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error('Migration inspection stopped:', error.message); process.exitCode = 1; })
        .finally(() => pool.end());
}

module.exports = { column, ascii, unicode, idx, fk, migrate, verify, cli, checksum, readTable, inspectObject, inspectPlan, assertApplyTarget, canonicalCheck, ledger };
