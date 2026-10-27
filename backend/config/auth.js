require('dotenv').config();

if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
    throw new Error('Configuration error: JWT_SECRET is required in .env');
}

module.exports = { secret: process.env.JWT_SECRET, expiresIn: '1h' };
