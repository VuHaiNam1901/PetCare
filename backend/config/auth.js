const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const WEAK_SECRETS = /^(?:secret|jwt_secret|changeme|password|123456|12345678|your_jwt_secret|default_secret)$/i;

function validateJwtSecret(rawSecret = process.env.JWT_SECRET, env = process.env) {
    if (!rawSecret || !String(rawSecret).trim()) {
        throw new Error('Configuration error: JWT_SECRET is required in .env');
    }
    const secret = String(rawSecret).trim();
    const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
    if (isProduction) {
        if (secret.length < 32 || /\s/.test(secret) || WEAK_SECRETS.test(secret) || /^(.)\1+$/.test(secret)) {
            throw new Error('Configuration error: JWT_SECRET must be at least 32 non-whitespace characters and non-trivial in production');
        }
    }
    return secret;
}

const secret = validateJwtSecret();

module.exports = { secret, expiresIn: '1h', validateJwtSecret };
