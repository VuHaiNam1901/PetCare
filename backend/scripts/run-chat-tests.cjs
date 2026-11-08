'use strict';

// Deliberately independent of run-tests.cjs: that runner creates a database and
// runs migrations. This runner only permits synthetic fixtures and loopback HTTP.
const fs = require('node:fs');
const path = require('node:path');
const backend = path.resolve(__dirname, '..');
const testRoot = path.join(backend, 'tests');
const requested = process.argv.slice(2);
const files = requested.length
    ? requested.map(file => path.resolve(backend, file))
    : fs.readdirSync(testRoot).filter(file => /^chat.*\.test\.js$/.test(file)).sort().map(file => path.join(testRoot, file));
if (!files.length || files.some(file => path.dirname(file) !== testRoot || !/^chat.*\.test\.js$/.test(path.basename(file)) || !fs.existsSync(file))) {
    throw new Error('Only existing backend/tests/chat*.test.js files are accepted');
}
const guard = require('./chat-test-guard.cjs');
const { run } = require('node:test');
const { tap } = require('node:test/reporters');
process.stdout.write('# Offline Chatbot tests: synthetic fixtures only; live MySQL cases are skipped; no real Gemini request.\n');
const stream = run({ files, isolation: 'none', concurrency: false });
stream.on('test:fail', () => { process.exitCode = 1; });
stream.on('error', error => {
    process.stderr.write(`Chatbot test runner failed: ${error.code || error.name}\n`);
    process.exitCode = 1;
});
stream.on('end', () => {
    process.stdout.write(`# Offline guard violations: ${guard.violations.length}\n`);
    if (guard.violations.length) {
        process.stderr.write(`Offline guard violations: ${guard.violations.join(', ')}\n`);
        process.exitCode = 1;
    }
});
stream.compose(tap).pipe(process.stdout);
