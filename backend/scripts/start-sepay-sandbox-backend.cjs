// Starts the isolated Sandbox Backend on SANDBOX_BACKEND_PORT (default 3002).
// Verifies SePay Test Mode isolation and SELECT DATABASE() before listening.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
const sandboxEnvPath = process.env.SEPAY_TEST_ENV_FILE || path.join(backendRoot, 'sepay-test', '.env');
const mainEnvPath = path.join(backendRoot, '.env');

if (!fs.existsSync(sandboxEnvPath)) {
    console.error('Missing backend/sepay-test/.env. Run `npm run sandbox:setup` first.');
    process.exit(1);
}

// Load isolated Sandbox config first; main .env only supplies missing connection credentials.
dotenv.config({ path: sandboxEnvPath, quiet: true });
dotenv.config({ path: mainEnvPath, quiet: true });
process.env.PORT = process.env.SANDBOX_BACKEND_PORT || '3002';

const sepayConfig = require('../config/sepay');
const pool = require('../config/db');

async function startSandboxBackend() {
    const settings = sepayConfig.testSettings(process.env);
    if (!sepayConfig.writesEnabled(process.env)) {
        throw new Error('SePay Sandbox write target is not enabled or does not match the isolated database');
    }
    const db = await pool.getConnection();
    try {
        const verifiedDb = await sepayConfig.assertWriteDatabase(db, process.env);
        if (verifiedDb === 'petcare_db') {
            throw new Error('Refusing to start Sandbox backend against petcare_db');
        }
        console.log(JSON.stringify({
            service: 'petcare-sandbox-backend',
            mode: 'test',
            database: verifiedDb,
            port: Number(process.env.PORT),
            sepayEnabled: true,
            sepayWritesEnabled: true,
            accountName: settings.accountName,
        }));
    } finally {
        db.release();
    }

    const app = require('../server');
    await app.start();
}

startSandboxBackend().catch(error => {
    console.error('Refusing to start Sandbox backend:', error.code || error.message);
    process.exit(1);
});
