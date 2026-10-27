const path = require('node:path');
const dotenv = require('dotenv');

// Keep the exact model/transport/output limits verified by test-gemini.cjs.
const MODEL = 'gemini-3.5-flash-lite';
const TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 512;
const HTTP_OPTIONS = Object.freeze({ timeout: TIMEOUT_MS, retryOptions: Object.freeze({ attempts: 1 }) });

function createGeminiClient() {
    const environment = dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
    const apiKey = environment.parsed?.GEMINI_API_KEY?.trim();
    if (environment.error || !apiKey) throw Object.assign(new Error('Gemini configuration is unavailable'), { code: 'GEMINI_CONFIG' });
    const { GoogleGenAI } = require('@google/genai');
    return new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { ...HTTP_OPTIONS, retryOptions: { ...HTTP_OPTIONS.retryOptions } } });
}

module.exports = { MODEL, TIMEOUT_MS, MAX_OUTPUT_TOKENS, HTTP_OPTIONS, createGeminiClient };
