'use strict';

// Pure, server-owned conversation state. No language classification, SDK, I/O,
// clock, or process cache. Callers persist the returned snapshot with the reply.
// A provenance quote is evidence of origin, not proof that an extraction is
// semantically correct; the future orchestrator must validate that separately.
// Only trusted server history may provide role=user; never trust a model or
// browser to supply an authoritative snapshot. Fact source kinds remain visible
// in getActiveContext; summary text never changes confirmation status.
const MEMORY_VERSION = 1;
const LIMITS = Object.freeze({ history: 12, message: 2000, summary: 1500,
    bytes: 32768, productIds: 6, productSets: 4, pets: 8, facts: 48,
    operations: 24, quote: 240 });
const SECTIONS = ['needs', 'constraints', 'preferences'];
const PET_FIELDS = ['name', 'species', 'age'];
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const fail = (code = 'MEMORY_INVALID') => { throw Object.assign(new Error(code), { code }); };
const assert = (condition, code) => { if (!condition) fail(code); };
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const storedJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

function jsonData(value) {
    let nodes = 0;
    const visiting = new Set();
    function visit(item, depth) {
        assert(++nodes <= 6000 && depth <= 16);
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number') return assert(Number.isFinite(item));
        assert(typeof item === 'object' && !visiting.has(item));
        const array = Array.isArray(item);
        assert(array ? Object.getPrototypeOf(item) === Array.prototype :
            [Object.prototype, null].includes(Object.getPrototypeOf(item)));
        visiting.add(item);
        const keys = Reflect.ownKeys(item);
        if (array) assert(keys.length === item.length + 1);
        for (const key of keys) {
            assert(typeof key === 'string' && !UNSAFE_KEYS.has(key));
            if (array && key === 'length') continue;
            if (array) assert(/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < item.length);
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            assert(descriptor.enumerable && own(descriptor, 'value'));
            visit(descriptor.value, depth + 1);
        }
        visiting.delete(item);
    }
    visit(value, 0);
}

function shape(value, required, optional = []) {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value));
    assert(required.every(key => own(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}

function text(value, max, empty = false) {
    assert(typeof value === 'string' && (empty || value.trim().length > 0) && [...value].length <= max &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
}
function identifier(value) {
    assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value) && !UNSAFE_KEYS.has(value));
}
function topic(value) {
    assert(typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) && !UNSAFE_KEYS.has(value));
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    assert(Number.isSafeInteger(value) && value >= min && value <= max);
}
function ids(value) {
    assert(Array.isArray(value) && value.length <= LIMITS.productIds && new Set(value).size === value.length);
    value.forEach(id => integer(id, 1, 2147483647));
}
function scope(value, state) {
    shape(value, ['pet_id', 'topic']);
    if (value.pet_id !== null) {
        identifier(value.pet_id);
        assert(state.pets.some(pet => pet.pet_id === value.pet_id));
    }
    if (value.topic !== null) topic(value.topic);
}

function provenance(source, memory, requireRecent = false) {
    shape(source, ['kind', 'turn_id', 'quote']);
    assert(['user', 'inference', 'legacy'].includes(source.kind));
    identifier(source.turn_id);
    text(source.quote, LIMITS.quote, source.kind !== 'user');
    const message = memory.recent_history.find(item => item.turn_id === source.turn_id);
    if (!message) assert(!requireRecent && memory.summary.through_sequence > 0, 'MEMORY_PROVENANCE');
    // Sources survive compaction as bounded references/quotes. Check the
    // original message whenever it is available; never invent a confirmation.
    if (message && source.kind === 'user') assert(message.role === 'user' && message.text.includes(source.quote), 'MEMORY_PROVENANCE');
}

function budget(value) {
    shape(value, ['currency', 'min', 'max']);
    assert(value.currency === 'VND' && (value.min !== null || value.max !== null));
    for (const bound of [value.min, value.max]) {
        if (bound !== null) assert(typeof bound === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(bound));
    }
    if (value.min !== null && value.max !== null) assert(BigInt(value.min.replace('.', '')) <= BigInt(value.max.replace('.', '')));
}
function factValue(value, key) {
    if (key === 'budget') return budget(value);
    if (key === 'name') return text(value, 80);
    if (key === 'age') {
        shape(value, ['amount', 'unit']);
        assert(Number.isFinite(value.amount) && value.amount >= 0 && value.amount <= 1000 &&
            ['days', 'weeks', 'months', 'years'].includes(value.unit));
        return;
    }
    if (key === 'species') return assert(['cat', 'dog', 'other'].includes(value));
    if (typeof value === 'string') return text(value, 240);
    if (typeof value === 'number') return assert(Number.isFinite(value) && Math.abs(value) <= 1e9);
    if (typeof value === 'boolean') return;
    assert(Array.isArray(value) && value.length <= 8);
    value.forEach(item => text(item, 80));
}
function fact(value, key, memory, requireRecent = false) {
    shape(value, ['value', 'source']);
    factValue(value.value, key);
    provenance(value.source, memory, requireRecent);
}

function createMemory() {
    return { schema_version: MEMORY_VERSION, revision: 0, last_sequence: 0,
        recent_history: [], summary: { text: '', through_sequence: 0, kind: null },
        state: { pets: [], active_pet_id: null, current_topic: null,
            needs: [], constraints: [], preferences: [],
            displayed_product_sets: [], focused_products: null } };
}

function validateMemory(memory) {
    jsonData(memory);
    assert(memory !== null && typeof memory === 'object' && !Array.isArray(memory) && own(memory, 'schema_version'));
    integer(memory.schema_version);
    assert(memory.schema_version === MEMORY_VERSION, 'MEMORY_VERSION_UNSUPPORTED');
    shape(memory, ['schema_version', 'revision', 'last_sequence', 'recent_history', 'summary', 'state']);
    integer(memory.revision);
    integer(memory.last_sequence);
    assert(memory.revision >= memory.last_sequence);
    shape(memory.summary, ['text', 'through_sequence', 'kind']);
    text(memory.summary.text, LIMITS.summary, true);
    integer(memory.summary.through_sequence, 0, memory.last_sequence);
    assert(memory.summary.through_sequence === 0
        ? memory.summary.text === '' && memory.summary.kind === null
        : memory.summary.text.trim().length > 0 && memory.summary.kind === 'inference');
    assert(Array.isArray(memory.recent_history) && memory.recent_history.length <= LIMITS.history);
    const seenTurns = new Set();
    memory.recent_history.forEach((message, index) => {
        shape(message, ['turn_id', 'sequence', 'role', 'text'], ['product_ids']);
        identifier(message.turn_id);
        assert(!seenTurns.has(message.turn_id));
        seenTurns.add(message.turn_id);
        assert(message.sequence === memory.summary.through_sequence + index + 1);
        assert(['user', 'assistant'].includes(message.role));
        text(message.text, LIMITS.message);
        if (own(message, 'product_ids')) { assert(message.role === 'assistant'); ids(message.product_ids); }
    });
    assert(memory.summary.through_sequence + memory.recent_history.length === memory.last_sequence);
    const state = memory.state;
    shape(state, ['pets', 'active_pet_id', 'current_topic', ...SECTIONS, 'displayed_product_sets', 'focused_products']);
    assert(Array.isArray(state.pets) && state.pets.length <= LIMITS.pets);
    const petIds = new Set();
    for (const pet of state.pets) {
        shape(pet, ['pet_id'], PET_FIELDS);
        identifier(pet.pet_id);
        assert(!petIds.has(pet.pet_id) && PET_FIELDS.some(field => own(pet, field)));
        petIds.add(pet.pet_id);
        for (const field of PET_FIELDS) if (own(pet, field)) fact(pet[field], field, memory);
    }
    assert(state.active_pet_id === null || petIds.has(state.active_pet_id));
    if (state.current_topic !== null) { fact(state.current_topic, 'topic', memory); topic(state.current_topic.value); }
    let factCount = 0;
    for (const section of SECTIONS) {
        assert(Array.isArray(state[section]));
        const seen = new Set();
        for (const entry of state[section]) {
            shape(entry, ['key', 'pet_id', 'topic', 'fact']);
            topic(entry.key);
            assert(entry.key !== 'budget' || section === 'constraints');
            assert(!['min_price', 'max_price', 'minPrice', 'maxPrice'].includes(entry.key));
            scope({ pet_id: entry.pet_id, topic: entry.topic }, state);
            const identity = JSON.stringify([entry.key, entry.pet_id, entry.topic]);
            assert(!seen.has(identity));
            seen.add(identity);
            fact(entry.fact, entry.key, memory);
        }
        factCount += state[section].length;
    }
    assert(factCount <= LIMITS.facts);
    assert(Array.isArray(state.displayed_product_sets) && state.displayed_product_sets.length <= LIMITS.productSets);
    let previousSequence = 0;
    const displayedTurns = new Set();
    for (const set of state.displayed_product_sets) {
        shape(set, ['turn_id', 'sequence', 'pet_id', 'topic', 'product_ids']);
        identifier(set.turn_id);
        assert(!displayedTurns.has(set.turn_id));
        displayedTurns.add(set.turn_id);
        integer(set.sequence, previousSequence + 1, memory.last_sequence);
        previousSequence = set.sequence;
        scope({ pet_id: set.pet_id, topic: set.topic }, state);
        ids(set.product_ids);
        assert(set.product_ids.length > 0);
        const message = memory.recent_history.find(item => item.sequence === set.sequence);
        if (set.sequence > memory.summary.through_sequence) {
            assert(message?.role === 'assistant' && message.turn_id === set.turn_id &&
                JSON.stringify(message.product_ids) === JSON.stringify(set.product_ids));
        } else assert(!memory.recent_history.some(item => item.turn_id === set.turn_id));
    }
    if (state.focused_products !== null) {
        const focus = state.focused_products;
        shape(focus, ['pet_id', 'topic', 'fact']);
        scope({ pet_id: focus.pet_id, topic: focus.topic }, state);
        shape(focus.fact, ['value', 'source']);
        ids(focus.fact.value);
        assert(focus.fact.value.length > 0);
        provenance(focus.fact.source, memory);
        assert(focus.pet_id === state.active_pet_id && focus.topic === (state.current_topic?.value ?? null));
        const displayed = state.displayed_product_sets.filter(set => set.pet_id === focus.pet_id && set.topic === focus.topic);
        assert(focus.fact.value.every(id => displayed.some(set => set.product_ids.includes(id))));
    }
    assert(storedJson(memory).length <= LIMITS.bytes, 'MEMORY_TOO_LARGE');
    return memory;
}

function candidate(memory) { return clone(validateMemory(memory)); }
function finish(next) {
    next.revision++;
    return validateMemory(next);
}

// History is never silently discarded. Compact with an externally supplied
// summary before appending beyond the window/byte budget.
function appendMessage(memory, input) {
    jsonData(input);
    shape(input, ['turn_id', 'role', 'text'], ['product_ids']);
    const next = candidate(memory);
    assert(next.recent_history.length < LIMITS.history, 'MEMORY_COMPACTION_REQUIRED');
    identifier(input.turn_id);
    assert(!next.recent_history.some(message => message.turn_id === input.turn_id) &&
        !next.state.displayed_product_sets.some(set => set.turn_id === input.turn_id));
    next.last_sequence++;
    const message = { ...clone(input), sequence: next.last_sequence };
    next.recent_history.push(message);
    if (input.role === 'assistant' && input.product_ids?.length) {
        next.state.displayed_product_sets.push({ turn_id: input.turn_id, sequence: next.last_sequence,
            pet_id: next.state.active_pet_id, topic: next.state.current_topic?.value ?? null,
            product_ids: clone(input.product_ids) });
        next.state.displayed_product_sets = next.state.displayed_product_sets.slice(-LIMITS.productSets);
        next.state.focused_products = null;
    }
    return finish(next);
}

function sourceChange(previous, incoming, confirming = false) {
    if (confirming) {
        assert(previous && previous.source.kind !== 'user' && incoming.kind === 'user', 'MEMORY_PROVENANCE');
    } else if (previous) {
        assert((previous.source.kind === 'user') === (incoming.kind === 'user'), 'MEMORY_PROVENANCE');
    }
}
function currentScope(state) { return { pet_id: state.active_pet_id, topic: state.current_topic?.value ?? null }; }

// All operations apply to a detached candidate. A failed operation or stale
// revision cannot partially mutate the caller's persisted snapshot.
// Operations: add_pet/update_pet(fields of {value,source}), remove_pet,
// switch_pet, switch_topic, set_fact/remove_fact/confirm_fact, confirm_pet_field,
// focus_products. Confirmation requires a recent user quote and may supply a
// corrected value. set_fact replaces a whole value; budget is always one
// {currency:'VND',min:decimal|null,max:decimal|null}, never merged bounds.
// Default fact scope is the active pet+topic. Explicit null scope components
// mean shared defaults; removing a fact removes that exact scope only.
function applyMemoryPatch(memory, patch) {
    jsonData(patch);
    shape(patch, ['base_revision', 'operations']);
    const next = candidate(memory);
    integer(patch.base_revision);
    assert(patch.base_revision === next.revision, 'MEMORY_REVISION_CONFLICT');
    assert(Array.isArray(patch.operations) && patch.operations.length > 0 && patch.operations.length <= LIMITS.operations);
    const state = next.state;
    for (const operation of patch.operations) {
        assert(operation && typeof operation.op === 'string');
        if (['add_pet', 'update_pet'].includes(operation.op)) {
            shape(operation, ['op', 'pet_id', 'fields']);
            identifier(operation.pet_id);
            shape(operation.fields, [], PET_FIELDS);
            assert(Object.keys(operation.fields).length > 0);
            let pet = state.pets.find(item => item.pet_id === operation.pet_id);
            assert(operation.op === 'add_pet' ? !pet : Boolean(pet));
            if (!pet) { pet = { pet_id: operation.pet_id }; state.pets.push(pet); }
            for (const [field, value] of Object.entries(operation.fields)) {
                fact(value, field, next, true);
                sourceChange(pet[field], value.source);
                pet[field] = clone(value);
            }
        } else if (operation.op === 'confirm_pet_field') {
            shape(operation, ['op', 'pet_id', 'field', 'source'], ['value']);
            assert(PET_FIELDS.includes(operation.field));
            const pet = state.pets.find(item => item.pet_id === operation.pet_id);
            const previous = pet?.[operation.field];
            provenance(operation.source, next, true);
            sourceChange(previous, operation.source, true);
            pet[operation.field] = { value: own(operation, 'value') ? clone(operation.value) : previous.value, source: clone(operation.source) };
            fact(pet[operation.field], operation.field, next, true);
        } else if (operation.op === 'remove_pet') {
            shape(operation, ['op', 'pet_id', 'source']);
            const pet = state.pets.find(item => item.pet_id === operation.pet_id);
            assert(Boolean(pet));
            provenance(operation.source, next, true);
            if (PET_FIELDS.some(field => pet[field]?.source.kind === 'user')) assert(operation.source.kind === 'user', 'MEMORY_PROVENANCE');
            state.pets = state.pets.filter(item => item.pet_id !== operation.pet_id);
            for (const section of SECTIONS) state[section] = state[section].filter(entry => entry.pet_id !== operation.pet_id);
            state.displayed_product_sets = state.displayed_product_sets.filter(set => set.pet_id !== operation.pet_id);
            if (state.active_pet_id === operation.pet_id) { state.active_pet_id = null; state.focused_products = null; }
        } else if (operation.op === 'switch_pet') {
            shape(operation, ['op', 'pet_id']);
            assert(operation.pet_id === null || state.pets.some(pet => pet.pet_id === operation.pet_id));
            if (state.active_pet_id !== operation.pet_id) state.focused_products = null;
            state.active_pet_id = operation.pet_id;
        } else if (operation.op === 'switch_topic') {
            shape(operation, ['op', 'topic', 'source']);
            topic(operation.topic);
            provenance(operation.source, next, true);
            if (state.current_topic?.value !== operation.topic) state.focused_products = null;
            state.current_topic = { value: operation.topic, source: clone(operation.source) };
        } else if (['set_fact', 'remove_fact', 'confirm_fact'].includes(operation.op)) {
            const setting = operation.op === 'set_fact';
            shape(operation, ['op', 'section', 'key', setting ? 'fact' : 'source'],
                ['scope', ...(operation.op === 'confirm_fact' ? ['value'] : [])]);
            assert(SECTIONS.includes(operation.section));
            topic(operation.key);
            const target = own(operation, 'scope') ? operation.scope : currentScope(state);
            scope(target, state);
            const entries = state[operation.section];
            const index = entries.findIndex(entry => entry.key === operation.key && entry.pet_id === target.pet_id && entry.topic === target.topic);
            const previous = index < 0 ? null : entries[index].fact;
            const source = setting ? operation.fact?.source : operation.source;
            provenance(source, next, true);
            if (setting) {
                fact(operation.fact, operation.key, next, true);
                sourceChange(previous, source);
                const entry = { key: operation.key, ...clone(target), fact: clone(operation.fact) };
                if (index < 0) entries.push(entry);
                else entries[index] = entry; // Replace the whole value, including budget bounds.
            } else if (operation.op === 'remove_fact') {
                assert(Boolean(previous));
                if (previous.source.kind === 'user') assert(source.kind === 'user', 'MEMORY_PROVENANCE');
                entries.splice(index, 1);
            } else {
                sourceChange(previous, source, true);
                const value = own(operation, 'value') ? clone(operation.value) : previous.value;
                entries[index].fact = { value, source: clone(source) };
                fact(entries[index].fact, operation.key, next, true);
            }
        } else if (operation.op === 'focus_products') {
            shape(operation, ['op', 'product_ids', 'source']);
            ids(operation.product_ids);
            assert(operation.product_ids.length > 0);
            provenance(operation.source, next, true);
            const target = currentScope(state);
            const displayed = state.displayed_product_sets.filter(set => set.pet_id === target.pet_id && set.topic === target.topic);
            assert(operation.product_ids.every(id => displayed.some(set => set.product_ids.includes(id))));
            state.focused_products = { ...target, fact: { value: clone(operation.product_ids), source: clone(operation.source) } };
        } else fail();
    }
    return finish(next);
}

function compactMemory(memory, input) {
    jsonData(input);
    shape(input, ['through_sequence', 'text']);
    const next = candidate(memory);
    text(input.text, LIMITS.summary);
    assert(next.recent_history.some(message => message.sequence === input.through_sequence));
    next.recent_history = next.recent_history.filter(message => message.sequence > input.through_sequence);
    next.summary = { text: input.text, through_sequence: input.through_sequence, kind: 'inference' };
    // The caller supplies a cumulative summary (previous summary + this prefix).
    // Core checks boundaries, not meaning, and never turns summary into facts.
    return finish(next);
}

function getActiveContext(memory) {
    const { state } = candidate(memory);
    const target = currentScope(state);
    const context = { pet: state.pets.find(pet => pet.pet_id === target.pet_id) ?? null,
        current_topic: state.current_topic, needs: {}, constraints: {}, preferences: {},
        displayed_product_set: [...state.displayed_product_sets].reverse().find(set => set.pet_id === target.pet_id && set.topic === target.topic) ?? null,
        focused_products: state.focused_products?.fact ?? null };
    for (const section of SECTIONS) {
        const selected = new Map();
        for (const entry of state[section]) {
            if ((entry.pet_id !== null && entry.pet_id !== target.pet_id) || (entry.topic !== null && entry.topic !== target.topic)) continue;
            const score = (entry.pet_id !== null ? 2 : 0) + (entry.topic !== null ? 1 : 0);
            const previous = selected.get(entry.key);
            const confirmed = entry.fact.source.kind === 'user';
            if (!previous || (confirmed && !previous.confirmed) || (confirmed === previous.confirmed && score > previous.score)) {
                selected.set(entry.key, { fact: entry.fact, score, confirmed });
            }
        }
        context[section] = Object.fromEntries([...selected].map(([key, entry]) => [key, entry.fact]));
    }
    return context;
}

// Resolves a model's structured 1-based position, never a natural-language regex.
function resolveDisplayedProduct(memory, input) {
    jsonData(input);
    shape(input, ['position'], ['turn_id']);
    integer(input.position, 1, LIMITS.productIds);
    if (own(input, 'turn_id')) identifier(input.turn_id);
    validateMemory(memory);
    const target = currentScope(memory.state);
    const set = [...memory.state.displayed_product_sets].reverse().find(item =>
        item.pet_id === target.pet_id && item.topic === target.topic && (!input.turn_id || item.turn_id === input.turn_id));
    return set?.product_ids[input.position - 1] ?? null;
}

// 32 KiB is the memory's own escaped budget, reserving space in the existing
// 60,000-byte history envelope. The store must still validate its whole envelope.
function serializeMemory(memory) { return storedJson(validateMemory(memory)); }

// There was no prior memory schema. Supported legacy data is session.history():
// [{role,text,product_ids?,search?}], or {history:[...]}. Search metadata is NOT
// promoted to pet facts, budget, or current inventory. Unknown versions fail.
function deserializeMemory(input) {
    if (typeof input === 'string') {
        assert(Buffer.byteLength(input, 'utf8') <= LIMITS.bytes, 'MEMORY_TOO_LARGE');
        if (!input.trim()) return createMemory();
        try { input = JSON.parse(input); } catch { fail(); }
    }
    if (input === null || input === undefined) return createMemory();
    jsonData(input);
    if (!Array.isArray(input) && typeof input === 'object' && Object.keys(input).length === 0) return createMemory();
    if (Array.isArray(input) || (input && typeof input === 'object' && !own(input, 'schema_version') && own(input, 'history'))) {
        let history = input;
        if (!Array.isArray(input)) { shape(input, ['history']); history = input.history; }
        assert(Array.isArray(history));
        assert(history.length <= LIMITS.history, 'MEMORY_COMPACTION_REQUIRED');
        let memory = createMemory();
        history.forEach((message, index) => {
            shape(message, ['role', 'text'], ['product_ids', 'search']);
            memory = appendMessage(memory, { turn_id: `legacy:${index + 1}`, role: message.role, text: message.text,
                ...(own(message, 'product_ids') ? { product_ids: message.product_ids } : {}) });
        });
        return memory;
    }
    return candidate(input);
}

function needsCompaction(memory) {
    validateMemory(memory);
    return memory.recent_history.length >= LIMITS.history - 2 || storedJson(memory).length >= LIMITS.bytes * 0.75;
}

module.exports = { MEMORY_VERSION, LIMITS, createMemory, validateMemory, appendMessage,
    applyMemoryPatch, compactMemory, serializeMemory, deserializeMemory,
    getActiveContext, resolveDisplayedProduct, needsCompaction };
