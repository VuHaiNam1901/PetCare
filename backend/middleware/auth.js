const jwt = require('jsonwebtoken');
const config = require('../config/auth');
const users = require('../models/user');

exports.authenticate = async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ success: false, message: 'Bearer token required' });
    let payload;
    try {
        payload = jwt.verify(match[1], config.secret, { algorithms: ['HS256'] });
        if (typeof payload.sub !== 'string' || !/^[1-9]\d*$/.test(payload.sub)) throw new Error('Invalid subject');
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    try {
        const user = await users.byId(payload.sub);
        if (!user) return res.status(401).json({ success: false, message: 'Account not found' });
        if (user.status !== 'active') return res.status(403).json({ success: false, message: 'Account is inactive' });
        req.user = user;
        next();
    } catch (error) { next(error); }
};

exports.authorize = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
};
