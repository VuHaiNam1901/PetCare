const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../config/auth');
const users = require('../models/user');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

function validate(body, mode) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
    const allowed = mode === 'login' ? ['email', 'password'] : mode === 'register'
        ? ['full_name', 'email', 'password', 'phone', 'address'] : ['full_name', 'email', 'phone', 'address'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error('Unsupported field (role/status cannot be changed)');
    const data = {};
    for (const key of Object.keys(body)) {
        const value = body[key];
        if ((key === 'phone' || key === 'address') && value === null) { data[key] = null; continue; }
        if (typeof value !== 'string') throw new Error(`${key} must be a string`);
        data[key] = key === 'password' ? value : value.trim();
    }
    const required = mode === 'register' ? ['full_name', 'email', 'password'] : mode === 'login' ? ['email', 'password'] : [];
    if (required.some(key => !data[key])) throw new Error('Required fields are missing');
    if (!Object.keys(data).length) throw new Error('At least one field is required');
    if ('full_name' in data && (!data.full_name || data.full_name.length > 100)) throw new Error('Invalid full_name');
    if ('email' in data) {
        data.email = data.email.toLowerCase();
        if (data.email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error('Invalid email');
    }
    if ('password' in data && (Buffer.byteLength(data.password) > 72 || (mode === 'register' && data.password.length < 8) || !data.password.length)) throw new Error('Password must be at least 8 characters for registration and at most 72 bytes');
    if (data.phone != null && data.phone !== '' && !/^\+?[0-9 ()-]{6,20}$/.test(data.phone)) throw new Error('Invalid phone');
    if (data.address != null && data.address.length > 255) throw new Error('Address is too long');
    return data;
}

const input = mode => (req, res, next) => {
    try { req.input = validate(req.body, mode); next(); }
    catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

router.post('/auth/register', input('register'), async (req, res) => {
    if (await users.byEmail(req.input.email)) return res.status(409).json({ success: false, message: 'Email already registered' });
    const hash = await bcrypt.hash(req.input.password, 12);
    const user = await users.create(req.input, hash);
    res.status(201).json({ success: true, user });
});

router.post('/auth/login', input('login'), async (req, res) => {
    const user = await users.byEmail(req.input.email);
    if (!user || !await bcrypt.compare(req.input.password, user.password)) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    if (user.status !== 'active') return res.status(403).json({ success: false, message: 'Account is inactive' });
    const token = jwt.sign({}, config.secret, { algorithm: 'HS256', subject: String(user.user_id), expiresIn: config.expiresIn });
    delete user.password;
    res.json({ success: true, token, token_type: 'Bearer', expires_in: 3600, user });
});

router.get('/auth/me', authenticate, (req, res) => res.json({ success: true, user: req.user }));
router.put('/users/me', authenticate, input('update'), async (req, res) => {
    const user = await users.update(req.user.user_id, req.input);
    res.json({ success: true, user });
});

module.exports = router;
