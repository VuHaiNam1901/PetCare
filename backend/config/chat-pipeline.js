'use strict';

// Read once when the chat router is constructed. Setting CHAT_PIPELINE in the
// server process (then restarting it) selects the implementation. This module
// never loads or edits .env, initializes Gemini, or opens a database connection.
// Omitted/empty -> legacy. Opt in with CHAT_PIPELINE=orchestrator; roll back by
// setting CHAT_PIPELINE=legacy and restarting all backend instances.
function readChatPipeline(environment = process.env) {
    const value = environment.CHAT_PIPELINE;
    if (value === undefined || value === '') return 'legacy';
    if (value === 'legacy' || value === 'orchestrator') return value;
    throw Object.assign(new Error('CHAT_PIPELINE must be legacy or orchestrator.'), { code: 'CHAT_PIPELINE_CONFIG' });
}

module.exports = { readChatPipeline };
