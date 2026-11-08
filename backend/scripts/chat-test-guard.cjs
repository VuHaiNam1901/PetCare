'use strict';

// Loaded only by the offline Chatbot test runner. All application modules remain
// real except credential/pool boundaries, which must fail before any I/O.
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const violations = [];
const blocked = operation => {
    violations.push(operation);
    throw Object.assign(new Error(`Offline Chatbot tests forbid ${operation}`), { code: 'CHAT_TEST_EXTERNAL_IO' });
};
const backend = path.resolve(__dirname, '..');
const cache = (filename, exports) => {
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const pool = Object.freeze({
    execute: () => blocked('database.execute'),
    query: () => blocked('database.query'),
    getConnection: () => blocked('database.getConnection'),
    async end() {}
});
cache(require.resolve('../config/db'), pool);
cache(require.resolve('../config/auth'), { secret: randomBytes(48).toString('hex'), expiresIn: '1h' });

const driver = Object.freeze({
    createPool: () => blocked('mysql.createPool'),
    createConnection: () => blocked('mysql.createConnection')
});
cache(require.resolve('mysql2'), driver);
cache(require.resolve('mysql2/promise'), driver);
require('dotenv').config = () => blocked('dotenv.config');
process.env.UC13_LIVE_DB_TEST = '0';
// A developer's live feature flag must not change legacy regression fixtures.
// Pipeline tests explicitly opt in, including tests of the environment flag.
process.env.CHAT_PIPELINE = 'legacy';

const load = Module._load;
Module._load = function (request, parent, isMain) {
    const filename = Module._resolveFilename(request, parent, isMain);
    if (typeof filename === 'string' && filename.startsWith(path.join(backend, 'migrations') + path.sep)) {
        return blocked('migration import');
    }
    return load.apply(this, arguments);
};

const isLoopback = hostname => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (options.path || !isLoopback(options.host || options.hostname || 'localhost')) return blocked('external socket');
    return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || !isLoopback(url.hostname)) return blocked('external fetch');
    return fetch(input, init);
};

module.exports = { violations };
