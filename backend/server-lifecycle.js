// Keep lifecycle ordering testable without booting application routes or MySQL.
function listen(app, port) {
    return new Promise((resolve, reject) => {
        let server;
        const onError = error => {
            server?.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };
        try {
            server = app.listen(port);
            server.once('error', onError);
            server.once('listening', onListening);
        } catch (error) { reject(error); }
    });
}

async function close(server, worker, pool) {
    const httpClosed = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    // Do not close the pool while an active HTTP request or expiry transaction
    // still owns a connection. Stop the timer promptly while requests drain.
    const results = await Promise.allSettled([httpClosed, Promise.resolve().then(() => worker?.stop())]);
    await pool.end();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
}
module.exports = { listen, close };
