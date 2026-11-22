const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUserPetModel, normalizePetName } = require('../models/user-pet');
const { createPetsRouter } = require('../routes/pets');
const petMigration = require('../migrations/011-user-pets');

const PET_TYPES = [
    { pet_type_id: 1, slug: 'dog', name: 'Chó' },
    { pet_type_id: 2, slug: 'cat', name: 'Mèo' },
    { pet_type_id: 3, slug: 'bird', name: 'Chim' },
    { pet_type_id: 4, slug: 'fish', name: 'Cá' },
    { pet_type_id: 5, slug: 'hamster', name: 'Hamster/Chuột' },
    { pet_type_id: 6, slug: 'rabbit', name: 'Thỏ' },
];

function createSyntheticPetPool({ users = [1, 2], ready = true } = {}) {
    let nextId = 1;
    const rows = [];

    function snapshotRow(r) {
        return { ...r };
    }

    function applyCheckAndUnique(candidateRows) {
        const defaultOwners = new Set();
        for (const r of candidateRows) {
            if (![0, 1].includes(r.is_default)) throw new Error('chk_user_pet_default is_default');
            if (!((r.default_slot === null && r.is_default === 0) || (r.default_slot === 1 && r.is_default === 1 && r.deleted_at === null))) {
                throw Object.assign(new Error('Check constraint chk_user_pet_default violated'), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
            }
            if (r.default_slot !== null) {
                const key = `${r.user_id}:${r.default_slot}`;
                if (defaultOwners.has(key)) {
                    throw Object.assign(new Error('Duplicate entry for uq_user_pet_default'), { code: 'ER_DUP_ENTRY' });
                }
                defaultOwners.add(key);
            }
        }
    }

    function makeConnection(stateRows) {
        let working = stateRows;
        let inTx = false;
        return {
            async beginTransaction() {
                inTx = true;
                working = rows.map(snapshotRow);
            },
            async commit() {
                rows.length = 0;
                rows.push(...working.map(snapshotRow));
                inTx = false;
            },
            async rollback() {
                working = rows.map(snapshotRow);
                inTx = false;
            },
            release() {},
            async execute(sql, params = []) {
                if (!ready) {
                    throw Object.assign(new Error("Table 'petcare_test.user_pets' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
                }
                const list = inTx ? working : rows;
                const trimmed = sql.replace(/\s+/g, ' ').trim();

                if (trimmed.startsWith('SELECT user_id FROM user WHERE user_id = ?')) {
                    return [users.includes(params[0]) ? [{ user_id: params[0] }] : []];
                }
                if (trimmed.startsWith('SELECT pet_type_id FROM pet_types WHERE pet_type_id = ?')) {
                    const found = PET_TYPES.find(t => t.pet_type_id === params[0]);
                    return [found ? [{ pet_type_id: found.pet_type_id }] : []];
                }
                if (trimmed.startsWith('SELECT pet_id, is_default FROM user_pets WHERE user_id = ? AND deleted_at IS NULL')) {
                    return [list.filter(r => r.user_id === params[0] && r.deleted_at === null).map(r => ({ pet_id: r.pet_id, is_default: r.is_default }))];
                }
                if (trimmed.startsWith('SELECT up.pet_id, up.user_id, up.pet_type_id')) {
                    let filtered = list.filter(r => r.deleted_at === null);
                    if (trimmed.includes('WHERE up.pet_id = ? AND up.user_id = ?')) {
                        filtered = filtered.filter(r => r.pet_id === params[0] && r.user_id === params[1]);
                    } else if (trimmed.includes('WHERE up.user_id = ? AND up.deleted_at IS NULL AND up.pet_type_id = ?')) {
                        filtered = filtered.filter(r => r.user_id === params[0] && r.pet_type_id === params[1]);
                    } else if (trimmed.includes('WHERE up.user_id = ? AND up.deleted_at IS NULL')) {
                        filtered = filtered.filter(r => r.user_id === params[0]);
                    }
                    filtered.sort((a, b) => (b.is_default - a.is_default) || (a.pet_id - b.pet_id));
                    return [filtered.map(r => {
                        const pt = PET_TYPES.find(t => t.pet_type_id === r.pet_type_id);
                        return { ...r, species_slug: pt.slug, species_name: pt.name };
                    })];
                }
                if (trimmed.startsWith('UPDATE user_pets SET is_default = 0, default_slot = NULL WHERE user_id = ? AND default_slot = 1 AND pet_id <> ?')) {
                    for (const r of list) {
                        if (r.user_id === params[0] && r.default_slot === 1 && r.pet_id !== params[1]) {
                            r.is_default = 0;
                            r.default_slot = null;
                        }
                    }
                    applyCheckAndUnique(list);
                    return [{ affectedRows: 1 }];
                }
                if (trimmed.startsWith('UPDATE user_pets SET is_default = 0, default_slot = NULL WHERE user_id = ? AND default_slot = 1')) {
                    for (const r of list) {
                        if (r.user_id === params[0] && r.default_slot === 1) {
                            r.is_default = 0;
                            r.default_slot = null;
                        }
                    }
                    applyCheckAndUnique(list);
                    return [{ affectedRows: 1 }];
                }
                if (trimmed.startsWith('UPDATE user_pets SET is_default = 1, default_slot = 1 WHERE pet_id = ? AND user_id = ?')) {
                    for (const r of list) {
                        if (r.pet_id === params[0] && r.user_id === params[1] && r.deleted_at === null) {
                            r.is_default = 1;
                            r.default_slot = 1;
                        }
                    }
                    applyCheckAndUnique(list);
                    return [{ affectedRows: 1 }];
                }
                if (trimmed.startsWith('UPDATE user_pets SET is_default = 0, default_slot = NULL, deleted_at = NOW()')) {
                    for (const r of list) {
                        if (r.pet_id === params[0] && r.user_id === params[1] && r.deleted_at === null) {
                            r.is_default = 0;
                            r.default_slot = null;
                            r.deleted_at = '2026-11-22T00:00:00Z';
                        }
                    }
                    applyCheckAndUnique(list);
                    return [{ affectedRows: 1 }];
                }
                if (trimmed.startsWith('INSERT INTO user_pets')) {
                    const row = {
                        pet_id: nextId++,
                        user_id: params[0],
                        pet_type_id: params[1],
                        name: params[2],
                        name_normalized: params[3],
                        breed: params[4],
                        age_months: params[5],
                        weight_kg: params[6],
                        gender: params[7],
                        activity_level: params[8],
                        health_notes: params[9],
                        is_default: params[10],
                        default_slot: params[11],
                        deleted_at: null,
                        created_at: '2026-11-22T00:00:00Z',
                        updated_at: '2026-11-22T00:00:00Z',
                    };
                    list.push(row);
                    applyCheckAndUnique(list);
                    return [{ insertId: row.pet_id }];
                }
                if (trimmed.startsWith('UPDATE user_pets SET ')) {
                    const match = trimmed.match(/^UPDATE user_pets SET (.+) WHERE pet_id = \? AND user_id = \? AND deleted_at IS NULL$/);
                    const assignments = match[1].split(',').map(part => part.trim().split(' = ')[0]);
                    const petId = params[params.length - 2];
                    const userId = params[params.length - 1];
                    const target = list.find(r => r.pet_id === petId && r.user_id === userId && r.deleted_at === null);
                    assert.ok(target, 'Target row must exist in synthetic pool');
                    assignments.forEach((col, index) => {
                        target[col] = params[index];
                    });
                    target.updated_at = '2026-11-22T01:00:00Z';
                    applyCheckAndUnique(list);
                    return [{ affectedRows: 1 }];
                }
                throw new Error(`Unexpected SQL in mock: ${trimmed}`);
            },
        };
    }

    return {
        rows,
        async execute(sql, params) {
            return makeConnection(rows).execute(sql, params);
        },
        async getConnection() {
            return makeConnection(rows);
        },
    };
}

test('user-pet model supports all 6 species, multiple pets, duplicate names, and preset avatars', async () => {
    const pool = createSyntheticPetPool();
    const model = createUserPetModel({ pool });

    const created = [];
    for (let typeId = 1; typeId <= 6; typeId++) {
        created.push(await model.createPet(1, {
            pet_type_id: typeId,
            name: `Bé ${typeId}`,
            breed: 'Giống mẫu',
            age_months: 12 + typeId,
            weight_kg: 2.5,
            gender: typeId % 2 === 0 ? 'female' : 'male',
            activity_level: 'high',
            health_notes: 'Khỏe mạnh',
        }));
    }
    const duplicate = await model.createPet(1, { pet_type_id: 2, name: 'Bé 1', is_default: false });
    created.push(duplicate);

    assert.equal(created.length, 7);
    assert.equal(created[0].avatar_url, '/images/home/pet-dog.jpg');
    assert.equal(created[1].avatar_url, '/images/home/pet-cat.jpg');
    assert.equal(created[2].avatar_url, '/images/home/pet-bird.jpg');
    assert.equal(created[3].avatar_url, '/images/home/pet-fish.jpg');
    assert.equal(created[4].avatar_url, '/images/home/pet-hamster.jpg');
    assert.equal(created[5].avatar_url, '/images/home/pet-rabbit.jpg');

    const listed = await model.listByUser(1);
    assert.equal(listed.length, 7);
    const filteredCats = await model.listByUser(1, { petTypeId: 2 });
    assert.equal(filteredCats.length, 2);
    assert.equal(normalizePetName('  Đốm  Trắng '), 'dom trang');
});

test('user-pet model enforces max 1 default pet atomically and soft-deletes cleanly', async () => {
    const pool = createSyntheticPetPool();
    const model = createUserPetModel({ pool });

    const first = await model.createPet(1, { pet_type_id: 1, name: 'Bông', is_default: true });
    assert.equal(first.is_default, true);

    const second = await model.createPet(1, { pet_type_id: 2, name: 'Mít', is_default: true });
    assert.equal(second.is_default, true);

    const refreshedFirst = await model.getByIdForUser(1, first.pet_id);
    assert.equal(refreshedFirst.is_default, false);

    const swapped = await model.setDefaultPet(1, first.pet_id);
    assert.equal(swapped.is_default, true);
    assert.equal((await model.getByIdForUser(1, second.pet_id)).is_default, false);

    await model.softDeletePet(1, first.pet_id);
    await assert.rejects(() => model.getByIdForUser(1, first.pet_id), err => err.status === 404);
    const remaining = await model.listByUser(1);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].pet_id, second.pet_id);

    const rawDeleted = pool.rows.find(row => row.pet_id === first.pet_id);
    assert.ok(rawDeleted.deleted_at);
    assert.equal(rawDeleted.is_default, 0);
    assert.equal(rawDeleted.default_slot, null);
});

test('user-pet validation rejects invalid species, age, weight, gender, activity, and empty name', async () => {
    const pool = createSyntheticPetPool();
    const model = createUserPetModel({ pool });

    await assert.rejects(() => model.createPet(1, { pet_type_id: 7, name: 'Test' }), err => err.status === 400);
    await assert.rejects(() => model.createPet(1, { pet_type_id: 1, name: '   ' }), err => err.status === 400);
    await assert.rejects(() => model.createPet(1, { pet_type_id: 1, name: 'Bông', age_months: -1 }), err => err.status === 400);
    await assert.rejects(() => model.createPet(1, { pet_type_id: 1, name: 'Bông', weight_kg: 0 }), err => err.status === 400);
    await assert.rejects(() => model.createPet(1, { pet_type_id: 1, name: 'Bông', gender: 'other' }), err => err.status === 400);
    await assert.rejects(() => model.createPet(1, { pet_type_id: 1, name: 'Bông', activity_level: 'extreme' }), err => err.status === 400);
});

function invokeRouter(router, { method = 'GET', url = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const req = Object.assign(new EventEmitter(), {
            method,
            url,
            originalUrl: `/api/pets${url === '/' ? '' : url}`,
            headers,
            body,
            query: {},
        });
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                if (!settled) {
                    settled = true;
                    resolve({ status: this.statusCode, body: payload });
                }
                return this;
            },
        };
        router(req, res, (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve({ status: 404, body: { success: false } });
        });
    });
}

test('pets HTTP router enforces auth, customer role, ownership isolation, and 503 readiness', async () => {
    const pool = createSyntheticPetPool();
    const petModel = createUserPetModel({ pool });

    const fakeAuth = (req, res, next) => {
        const header = req.headers['x-test-user'];
        if (!header) return res.status(401).json({ success: false, message: 'Auth required' });
        const [user_id, role] = header.split(':');
        req.user = { user_id: Number(user_id), role };
        next();
    };
    const fakeAuthorize = (...roles) => (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false });
        if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, message: 'Forbidden' });
        next();
    };

    const router = createPetsRouter({ petModel, authenticate: fakeAuth, authorize: fakeAuthorize });

    const unauth = await invokeRouter(router, { method: 'GET', url: '/' });
    assert.equal(unauth.status, 401);

    const adminRes = await invokeRouter(router, { method: 'GET', url: '/', headers: { 'x-test-user': '1:admin' } });
    assert.equal(adminRes.status, 403);

    const createRes = await invokeRouter(router, {
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json', 'x-test-user': '1:user' },
        body: { pet_type_id: 6, name: 'Thỏ Bông', weight_kg: 1.8, is_default: true },
    });
    assert.equal(createRes.status, 201);
    const created = createRes.body.pet;

    // Cross-user isolation: user 2 cannot read, edit, set default, or delete user 1's pet
    assert.equal((await invokeRouter(router, { method: 'GET', url: `/${created.pet_id}`, headers: { 'x-test-user': '2:user' } })).status, 404);
    assert.equal((await invokeRouter(router, {
        method: 'PUT',
        url: `/${created.pet_id}`,
        headers: { 'content-type': 'application/json', 'x-test-user': '2:user' },
        body: { name: 'Hijack' },
    })).status, 404);
    assert.equal((await invokeRouter(router, {
        method: 'PATCH',
        url: `/${created.pet_id}/default`,
        headers: { 'x-test-user': '2:user' },
    })).status, 404);
    assert.equal((await invokeRouter(router, {
        method: 'DELETE',
        url: `/${created.pet_id}`,
        headers: { 'x-test-user': '2:user' },
    })).status, 404);

    const ownerCheck = await invokeRouter(router, { method: 'GET', url: `/${created.pet_id}`, headers: { 'x-test-user': '1:user' } });
    assert.equal(ownerCheck.status, 200);
    assert.equal(ownerCheck.body.pet.name, 'Thỏ Bông');

    const notReadyModel = createUserPetModel({ pool: createSyntheticPetPool({ ready: false }) });
    await assert.rejects(() => notReadyModel.listByUser(1), err => err.status === 503 && err.code === 'PET_PROFILE_NOT_READY');
});

test('011-user-pets migration guards exact database match and rejects generated columns', async () => {
    const fakePool = {
        async getConnection() {
            return {
                release() {},
                async query() { return [[{ name: 'petcare_db' }]]; },
                async execute() { return [[]]; },
            };
        },
    };
    await assert.rejects(
        () => petMigration.migrate(fakePool, { apply: true, expectedDatabase: 'other_db' }),
        /exact expected database/i
    );

    const generatedColDb = {
        async execute() { return [[{ ENGINE: 'InnoDB' }]]; },
        async query(sql) {
            if (sql.includes('SHOW COLUMNS')) {
                return [[{ Field: 'default_slot', Type: 'tinyint', Null: 'YES', Extra: 'VIRTUAL GENERATED' }]];
            }
            return [[]];
        },
    };
    await assert.rejects(
        () => petMigration.verify(generatedColDb),
        /must not use GENERATED columns/i
    );
});
