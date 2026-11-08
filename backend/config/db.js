
const mysql = require('mysql2/promise');
require('dotenv').config();

// Fail before opening a connection when a test is launched without the isolated
// runner. In particular, `node --test` must never fall back to the normal .env DB.
const testProcess = process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' ||
    process.argv.slice(1).some(argument => /(?:^|[\\/])tests[\\/].*\.test\.[cm]?js$/.test(argument));
if (testProcess) {
    const database = process.env.PETCARE_TEST_DATABASE;
    const source = process.env.PETCARE_TEST_SOURCE_DATABASE;
    if (!/^petcare_test_[a-f0-9]{32}$/.test(database || '') || database !== process.env.DB_NAME ||
        !source || source === database || process.env.PETCARE_TEST_ISOLATED !== '1') {
        throw new Error('Tests require an isolated database. Run npm test; the application database is never a test target.');
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // New financial/lifecycle columns explicitly store UTC wall-clock values.
    // Do not reinterpret the legacy local DATETIME columns or change their API.
    typeCast(field, next) {
        if (field.type === 'DATETIME' && (field.name.endsWith('_utc') || ['payment_expires_at', 'cancelled_at'].includes(field.name))) {
            const value = field.string();
            return value === null ? null : value.replace(' ', 'T') + 'Z';
        }
        return next();
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
