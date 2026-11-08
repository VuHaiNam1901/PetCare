const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const lifecycle = require('../server-lifecycle');

test('server readiness resolves only after listening succeeds', async () => {
    const server = new EventEmitter();
    let ready = false;
    const result = lifecycle.listen({ listen() { return server; } }, 0).then(value => { ready = true; return value; });
    await Promise.resolve();
    assert.equal(ready, false, 'A worker must not start on an unbound server');
    server.emit('listening');
    assert.equal(await result, server);
    assert.equal(server.listenerCount('error'), 0);
});

test('an occupied port is a caught startup failure before worker startup', async () => {
    const occupied = http.createServer((req, res) => res.end('synthetic fixture'));
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const port = occupied.address().port;
    let workerStarted = false;
    try {
        await assert.rejects((async () => {
            await lifecycle.listen({ listen(value) { return http.createServer().listen(value, '127.0.0.1'); } }, port);
            workerStarted = true;
        })(), { code: 'EADDRINUSE' });
        assert.equal(workerStarted, false);
    } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('shutdown waits for both HTTP drain and the worker before closing the pool', async () => {
    let httpDone, workerDone, ended = false;
    const workerStopped = new Promise(resolve => { workerDone = resolve; });
    const stopping = lifecycle.close({ close(callback) { httpDone = callback; } },
        { stop() { return workerStopped; } }, { async end() { ended = true; } });
    await Promise.resolve();
    httpDone();
    await Promise.resolve();
    assert.equal(ended, false);
    workerDone();
    await stopping;
    assert.equal(ended, true);
});

test('shutdown failure is observable after the remaining resources are drained', async () => {
    let ended = false;
    await assert.rejects(lifecycle.close({ close(callback) { callback(); } },
        { async stop() { throw Object.assign(new Error('Synthetic shutdown failure'), { code: 'SYNTHETIC_STOP' }); } },
        { async end() { ended = true; } }), { code: 'SYNTHETIC_STOP' });
    assert.equal(ended, true);
});
