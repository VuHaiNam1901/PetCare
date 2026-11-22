const getDefaultPool = () => require('../config/db');
const getPetTypesModel = () => require('./pet-types');

const SPECIES_META = Object.freeze({
    1: { pet_type_id: 1, slug: 'dog', name: 'Chó', avatar_url: '/images/home/pet-dog.jpg' },
    2: { pet_type_id: 2, slug: 'cat', name: 'Mèo', avatar_url: '/images/home/pet-cat.jpg' },
    3: { pet_type_id: 3, slug: 'bird', name: 'Chim', avatar_url: '/images/home/pet-bird.jpg' },
    4: { pet_type_id: 4, slug: 'fish', name: 'Cá', avatar_url: '/images/home/pet-fish.jpg' },
    5: { pet_type_id: 5, slug: 'hamster', name: 'Hamster/Chuột', avatar_url: '/images/home/pet-hamster.jpg' },
    6: { pet_type_id: 6, slug: 'rabbit', name: 'Thỏ', avatar_url: '/images/home/pet-rabbit.jpg' },
});

const VALID_GENDERS = new Set(['male', 'female', 'unknown']);
const VALID_ACTIVITY_LEVELS = new Set(['low', 'medium', 'high']);

const createHttpError = (status, code, message, extra = {}) =>
    Object.assign(new Error(message), { status, code, ...extra });

const normalizePetName = (value) =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');

const hasControlChars = (value) => /[\u0000-\u001f\u007f]/.test(value);

const parsePositiveInt = (value, code = 'INVALID_ID', message = 'ID không hợp lệ') => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) return Number(value.trim());
    throw createHttpError(400, code, message);
};

function normalizeRequiredString(value, { maxLen, emptyCode, emptyMessage, tooLongCode, tooLongMessage }) {
    if (typeof value !== 'string') throw createHttpError(400, emptyCode, emptyMessage);
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) throw createHttpError(400, emptyCode, emptyMessage);
    if (hasControlChars(trimmed) || trimmed.length > maxLen) {
        throw createHttpError(400, tooLongCode, tooLongMessage);
    }
    return trimmed;
}

function normalizeOptionalString(value, { maxLen, code, message }) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw createHttpError(400, code, message);
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) return null;
    if (hasControlChars(trimmed) || trimmed.length > maxLen) {
        throw createHttpError(400, code, message);
    }
    return trimmed;
}

function normalizeOptionalAgeMonths(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 0 || numeric > 600) {
        throw createHttpError(400, 'INVALID_AGE_MONTHS', 'Tuổi thú cưng phải là số nguyên từ 0 đến 600 tháng.');
    }
    return numeric;
}

function normalizeOptionalWeightKg(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0 || numeric > 250) {
        throw createHttpError(400, 'INVALID_WEIGHT_KG', 'Cân nặng phải lớn hơn 0 và tối đa 250 kg.');
    }
    return Number(numeric.toFixed(2));
}

function normalizePetTypeId(value) {
    const id = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isInteger(id) || !SPECIES_META[id]) {
        throw createHttpError(400, 'INVALID_PET_TYPE', 'Loài thú cưng không hợp lệ (chỉ hỗ trợ 6 loài của hệ thống).');
    }
    return id;
}

function normalizeGender(value) {
    if (value === undefined || value === null || value === '') return 'unknown';
    if (typeof value !== 'string' || !VALID_GENDERS.has(value.trim())) {
        throw createHttpError(400, 'INVALID_GENDER', 'Giới tính thú cưng không hợp lệ.');
    }
    return value.trim();
}

function normalizeActivityLevel(value) {
    if (value === undefined || value === null || value === '') return 'medium';
    if (typeof value !== 'string' || !VALID_ACTIVITY_LEVELS.has(value.trim())) {
        throw createHttpError(400, 'INVALID_ACTIVITY_LEVEL', 'Mức độ vận động không hợp lệ.');
    }
    return value.trim();
}

function normalizeBooleanFlag(value, defaultValue = false) {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    throw createHttpError(400, 'INVALID_IS_DEFAULT', 'Giá trị mặc định phải là true hoặc false.');
}

function validatePetPayload(payload, { partial = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw createHttpError(400, 'INVALID_PAYLOAD', 'Dữ liệu hồ sơ thú cưng không hợp lệ.');
    }
    const clean = {};

    if (!partial || payload.pet_type_id !== undefined) {
        clean.pet_type_id = normalizePetTypeId(payload.pet_type_id);
    }
    if (!partial || payload.name !== undefined) {
        clean.name = normalizeRequiredString(payload.name, {
            maxLen: 80,
            emptyCode: 'INVALID_PET_NAME',
            emptyMessage: 'Vui lòng nhập tên thú cưng.',
            tooLongCode: 'INVALID_PET_NAME',
            tooLongMessage: 'Tên thú cưng tối đa 80 ký tự và không chứa ký tự điều khiển.',
        });
        clean.name_normalized = normalizePetName(clean.name);
        if (!clean.name_normalized) {
            throw createHttpError(400, 'INVALID_PET_NAME', 'Tên thú cưng không hợp lệ.');
        }
    }
    if (!partial || payload.breed !== undefined) {
        clean.breed = normalizeOptionalString(payload.breed, {
            maxLen: 80,
            code: 'INVALID_BREED',
            message: 'Giống thú cưng tối đa 80 ký tự.',
        });
    }
    if (!partial || payload.age_months !== undefined) {
        clean.age_months = normalizeOptionalAgeMonths(payload.age_months);
    }
    if (!partial || payload.weight_kg !== undefined) {
        clean.weight_kg = normalizeOptionalWeightKg(payload.weight_kg);
    }
    if (!partial || payload.gender !== undefined) {
        clean.gender = normalizeGender(payload.gender);
    }
    if (!partial || payload.activity_level !== undefined) {
        clean.activity_level = normalizeActivityLevel(payload.activity_level);
    }
    if (!partial || payload.health_notes !== undefined) {
        clean.health_notes = normalizeOptionalString(payload.health_notes, {
            maxLen: 300,
            code: 'INVALID_HEALTH_NOTES',
            message: 'Ghi chú sức khỏe/dị ứng tối đa 300 ký tự.',
        });
    }
    if (!partial || payload.is_default !== undefined) {
        clean.is_default = normalizeBooleanFlag(payload.is_default, false);
    }

    if (partial && Object.keys(clean).length === 0) {
        throw createHttpError(400, 'EMPTY_UPDATE', 'Không có trường dữ liệu nào để cập nhật.');
    }
    return clean;
}

function serializePet(row) {
    const meta = SPECIES_META[Number(row.pet_type_id)] || {};
    return {
        pet_id: Number(row.pet_id),
        user_id: Number(row.user_id),
        pet_type_id: Number(row.pet_type_id),
        species_slug: row.species_slug || meta.slug || null,
        species_name: row.species_name || meta.name || null,
        avatar_url: meta.avatar_url || '/images/home/pet-dog.jpg',
        name: row.name,
        breed: row.breed ?? null,
        age_months: row.age_months === null || row.age_months === undefined ? null : Number(row.age_months),
        weight_kg: row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg),
        gender: row.gender || 'unknown',
        activity_level: row.activity_level || 'medium',
        health_notes: row.health_notes ?? null,
        is_default: Boolean(Number(row.is_default)),
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
    };
}

function mapDbError(error) {
    if (error && ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.code)) {
        return createHttpError(
            503,
            'PET_PROFILE_NOT_READY',
            'Tính năng Hồ sơ thú cưng chưa được khởi tạo cơ sở dữ liệu.'
        );
    }
    if (error && error.code === 'ER_LOCK_DEADLOCK') {
        return createHttpError(
            409,
            'LOCK_DEADLOCK',
            'Hệ thống đang bận cập nhật dữ liệu, vui lòng thử lại.',
            { retryable: true }
        );
    }
    return error;
}

const SELECT_PET_SQL = `
    SELECT up.pet_id, up.user_id, up.pet_type_id,
           pt.slug AS species_slug, pt.name AS species_name,
           up.name, up.breed, up.age_months, up.weight_kg,
           up.gender, up.activity_level, up.health_notes,
           up.is_default, up.created_at, up.updated_at
    FROM user_pets up
    JOIN pet_types pt ON pt.pet_type_id = up.pet_type_id
`;

function createUserPetModel({ pool } = {}) {
    const dbPool = () => pool || getDefaultPool();

    async function getActivePetRow(db, userId, petId, { forUpdate = false } = {}) {
        const lockSuffix = forUpdate ? ' FOR UPDATE' : '';
        const [rows] = await db.execute(
            `${SELECT_PET_SQL} WHERE up.pet_id = ? AND up.user_id = ? AND up.deleted_at IS NULL${lockSuffix}`,
            [petId, userId]
        );
        return rows[0] || null;
    }

    async function assertUserAndPetType(db, userId, petTypeId) {
        const [[user]] = await db.execute('SELECT user_id FROM user WHERE user_id = ? FOR UPDATE', [userId]);
        if (!user) throw createHttpError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
        if (petTypeId !== undefined) {
            const [[petType]] = await db.execute('SELECT pet_type_id FROM pet_types WHERE pet_type_id = ? FOR SHARE', [petTypeId]);
            if (!petType) {
                throw createHttpError(400, 'INVALID_PET_TYPE', 'Loài thú cưng không tồn tại trong hệ thống.');
            }
        }
    }

    async function withUserLock(userId, fn) {
        const db = await dbPool().getConnection();
        let inTx = false;
        try {
            await db.beginTransaction();
            inTx = true;
            const result = await fn(db);
            await db.commit();
            inTx = false;
            return result;
        } catch (error) {
            if (inTx) {
                try { await db.rollback(); } catch {}
            }
            throw mapDbError(error);
        } finally {
            db.release();
        }
    }

    async function listByUser(rawUserId, { petTypeId } = {}) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const params = [userId];
        let extraWhere = '';
        if (petTypeId !== undefined && petTypeId !== null && petTypeId !== '') {
            extraWhere = ' AND up.pet_type_id = ?';
            params.push(normalizePetTypeId(petTypeId));
        }
        try {
            const [rows] = await dbPool().execute(
                `${SELECT_PET_SQL}
                 WHERE up.user_id = ? AND up.deleted_at IS NULL${extraWhere}
                 ORDER BY up.is_default DESC, up.pet_id ASC`,
                params
            );
            return rows.map(serializePet);
        } catch (error) {
            throw mapDbError(error);
        }
    }

    async function getByIdForUser(rawUserId, rawPetId) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const petId = parsePositiveInt(rawPetId, 'INVALID_PET_ID', 'Mã thú cưng không hợp lệ');
        try {
            const row = await getActivePetRow(dbPool(), userId, petId);
            if (!row) throw createHttpError(404, 'PET_NOT_FOUND', 'Không tìm thấy hồ sơ thú cưng.');
            return serializePet(row);
        } catch (error) {
            throw mapDbError(error);
        }
    }

    async function createPet(rawUserId, payload) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const clean = validatePetPayload(payload, { partial: false });

        return withUserLock(userId, async (db) => {
            await assertUserAndPetType(db, userId, clean.pet_type_id);
            await db.execute(
                'SELECT pet_id, is_default FROM user_pets WHERE user_id = ? AND deleted_at IS NULL FOR UPDATE',
                [userId]
            );

            if (clean.is_default) {
                await db.execute(
                    'UPDATE user_pets SET is_default = 0, default_slot = NULL WHERE user_id = ? AND default_slot = 1',
                    [userId]
                );
            }

            const [result] = await db.execute(
                `INSERT INTO user_pets
                    (user_id, pet_type_id, name, name_normalized, breed, age_months, weight_kg, gender, activity_level, health_notes, is_default, default_slot)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    clean.pet_type_id,
                    clean.name,
                    clean.name_normalized,
                    clean.breed,
                    clean.age_months,
                    clean.weight_kg,
                    clean.gender,
                    clean.activity_level,
                    clean.health_notes,
                    clean.is_default ? 1 : 0,
                    clean.is_default ? 1 : null,
                ]
            );
            const created = await getActivePetRow(db, userId, result.insertId);
            return serializePet(created);
        });
    }

    async function updatePet(rawUserId, rawPetId, payload) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const petId = parsePositiveInt(rawPetId, 'INVALID_PET_ID', 'Mã thú cưng không hợp lệ');
        const clean = validatePetPayload(payload, { partial: true });

        return withUserLock(userId, async (db) => {
            await assertUserAndPetType(db, userId, clean.pet_type_id);
            const [activeRows] = await db.execute(
                'SELECT pet_id, is_default FROM user_pets WHERE user_id = ? AND deleted_at IS NULL FOR UPDATE',
                [userId]
            );
            const current = activeRows.find(row => Number(row.pet_id) === petId);
            if (!current) throw createHttpError(404, 'PET_NOT_FOUND', 'Không tìm thấy hồ sơ thú cưng.');

            if (clean.is_default === true) {
                await db.execute(
                    'UPDATE user_pets SET is_default = 0, default_slot = NULL WHERE user_id = ? AND default_slot = 1 AND pet_id <> ?',
                    [userId, petId]
                );
            }

            const sets = [];
            const params = [];
            const fields = ['pet_type_id', 'name', 'name_normalized', 'breed', 'age_months', 'weight_kg', 'gender', 'activity_level', 'health_notes'];
            for (const field of fields) {
                if (Object.prototype.hasOwnProperty.call(clean, field)) {
                    sets.push(`${field} = ?`);
                    params.push(clean[field]);
                }
            }
            if (Object.prototype.hasOwnProperty.call(clean, 'is_default')) {
                sets.push('is_default = ?', 'default_slot = ?');
                params.push(clean.is_default ? 1 : 0, clean.is_default ? 1 : null);
            }
            params.push(petId, userId);

            await db.execute(
                `UPDATE user_pets SET ${sets.join(', ')} WHERE pet_id = ? AND user_id = ? AND deleted_at IS NULL`,
                params
            );
            const updated = await getActivePetRow(db, userId, petId);
            return serializePet(updated);
        });
    }

    async function setDefaultPet(rawUserId, rawPetId) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const petId = parsePositiveInt(rawPetId, 'INVALID_PET_ID', 'Mã thú cưng không hợp lệ');

        return withUserLock(userId, async (db) => {
            await assertUserAndPetType(db, userId);
            const [activeRows] = await db.execute(
                'SELECT pet_id, is_default FROM user_pets WHERE user_id = ? AND deleted_at IS NULL FOR UPDATE',
                [userId]
            );
            if (!activeRows.some(row => Number(row.pet_id) === petId)) {
                throw createHttpError(404, 'PET_NOT_FOUND', 'Không tìm thấy hồ sơ thú cưng.');
            }
            await db.execute(
                'UPDATE user_pets SET is_default = 0, default_slot = NULL WHERE user_id = ? AND default_slot = 1 AND pet_id <> ?',
                [userId, petId]
            );
            await db.execute(
                'UPDATE user_pets SET is_default = 1, default_slot = 1 WHERE pet_id = ? AND user_id = ? AND deleted_at IS NULL',
                [petId, userId]
            );
            const updated = await getActivePetRow(db, userId, petId);
            return serializePet(updated);
        });
    }

    async function softDeletePet(rawUserId, rawPetId) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const petId = parsePositiveInt(rawPetId, 'INVALID_PET_ID', 'Mã thú cưng không hợp lệ');

        return withUserLock(userId, async (db) => {
            await assertUserAndPetType(db, userId);
            const target = await getActivePetRow(db, userId, petId, { forUpdate: true });
            if (!target) throw createHttpError(404, 'PET_NOT_FOUND', 'Không tìm thấy hồ sơ thú cưng.');

            await db.execute(
                'UPDATE user_pets SET is_default = 0, default_slot = NULL, deleted_at = NOW() WHERE pet_id = ? AND user_id = ? AND deleted_at IS NULL',
                [petId, userId]
            );
            return { pet_id: petId };
        });
    }

    async function listSpecies() {
        if (pool) {
            const current = await getPetTypesModel().state(pool);
            const list = current.ready ? current.pet_types : Object.values(SPECIES_META);
            return list.map(item => ({
                ...item,
                avatar_url: SPECIES_META[item.pet_type_id]?.avatar_url || '/images/home/pet-dog.jpg',
            }));
        }
        const current = await getPetTypesModel().list({ availableOnly: false });
        return current.pet_types.map(item => ({
            ...item,
            avatar_url: SPECIES_META[item.pet_type_id]?.avatar_url || '/images/home/pet-dog.jpg',
        }));
    }

    async function getPetPurchaseHistory(rawUserId, rawPetId, { limit = 50 } = {}) {
        const userId = parsePositiveInt(rawUserId, 'INVALID_USER_ID', 'User ID không hợp lệ');
        const petId = parsePositiveInt(rawPetId, 'INVALID_PET_ID', 'Mã thú cưng không hợp lệ');
        const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;

        try {
            const petRow = await getActivePetRow(dbPool(), userId, petId);
            if (!petRow) throw createHttpError(404, 'PET_NOT_FOUND', 'Không tìm thấy hồ sơ thú cưng.');

            const [rows] = await dbPool().execute(
                `SELECT
                    odp.order_detail_id,
                    odp.order_id,
                    odp.pet_id,
                    odp.product_id,
                    odp.pet_type_id,
                    odp.pet_name_snapshot,
                    d.quantity,
                    d.unit_price,
                    d.subtotal,
                    o.order_date,
                    o.status AS order_status,
                    o.rejection_reason,
                    pr.name AS product_name,
                    pr.image_url AS product_image_url,
                    pr.price AS current_price,
                    pr.stock_quantity AS current_stock_quantity,
                    pr.status AS product_status,
                    c.category_id,
                    c.name AS category_name,
                    (SELECT p.payment_method FROM payments p WHERE p.order_id = o.order_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_method,
                    (SELECT p.payment_status FROM payments p WHERE p.order_id = o.order_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_status,
                    CASE
                        WHEN o.status = 'Đã giao hàng'
                         AND o.approved_at IS NOT NULL
                         AND o.stock_restored_at IS NULL
                         AND o.rejection_reason IS NULL
                         AND EXISTS (
                             SELECT 1 FROM payments p
                             WHERE p.order_id = o.order_id
                               AND p.payment_method IN ('COD', 'ONLINE')
                               AND p.payment_status = 'Đã thanh toán'
                               AND p.transaction_date IS NOT NULL
                               AND p.amount = o.total_amount
                         )
                        THEN 1 ELSE 0
                    END AS is_completed_purchase
                FROM order_detail_pets odp
                JOIN order_details d ON d.order_detail_id = odp.order_detail_id
                JOIN orders o ON o.order_id = odp.order_id
                JOIN products pr ON pr.product_id = odp.product_id
                LEFT JOIN categories c ON c.category_id = pr.category_id
                WHERE odp.pet_id = ?
                  AND odp.user_id = ?
                  AND o.user_id = ?
                  AND d.quantity > 0
                ORDER BY o.order_date DESC, odp.order_detail_id DESC
                LIMIT ${safeLimit}`,
                [petId, userId, userId]
            );

            const completedProducts = [];
            const pendingProducts = [];
            let cancelledCount = 0;

            for (const row of rows) {
                const isCompleted = Number(row.is_completed_purchase) === 1;
                const isCancelled = row.order_status === 'Đã hủy' || Boolean(row.rejection_reason);
                if (!isCompleted && isCancelled) {
                    cancelledCount++;
                    continue;
                }
                const entry = {
                    order_detail_id: Number(row.order_detail_id),
                    order_id: Number(row.order_id),
                    pet_id: Number(row.pet_id),
                    pet_name_snapshot: row.pet_name_snapshot,
                    product_id: Number(row.product_id),
                    product_name: row.product_name,
                    image_url: row.product_image_url,
                    category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
                    category_name: row.category_name || null,
                    quantity: Number(row.quantity),
                    unit_price: row.unit_price == null ? null : String(row.unit_price),
                    subtotal: row.subtotal == null ? null : String(row.subtotal),
                    order_date: row.order_date ?? null,
                    order_status: row.order_status,
                    payment_method: row.payment_method || null,
                    payment_status: row.payment_status || null,
                    purchase_state: isCompleted ? 'completed' : 'pending',
                    current_price: row.current_price == null ? null : String(row.current_price),
                    current_stock_quantity: row.current_stock_quantity === null || row.current_stock_quantity === undefined ? 0 : Number(row.current_stock_quantity),
                    product_status: row.product_status || null,
                    currently_available: row.product_status === 'Đang bán' && Number(row.current_stock_quantity) > 0,
                };
                if (isCompleted) completedProducts.push(entry);
                else pendingProducts.push(entry);
            }

            return {
                pet: serializePet(petRow),
                completed_products: completedProducts,
                pending_products: pendingProducts,
                summary: {
                    completed_count: completedProducts.length,
                    pending_count: pendingProducts.length,
                    cancelled_count: cancelledCount,
                    unique_completed_products: new Set(completedProducts.map(item => item.product_id)).size,
                },
                confirmed_consumption: false,
            };
        } catch (error) {
            throw mapDbError(error);
        }
    }

    return {
        listByUser,
        getByIdForUser,
        createPet,
        updatePet,
        setDefaultPet,
        softDeletePet,
        getPetPurchaseHistory,
        listSpecies,
        normalizePetName,
        validatePetPayload,
        SPECIES_META,
    };
}

const defaultModel = createUserPetModel();

module.exports = {
    createUserPetModel,
    normalizePetName,
    validatePetPayload,
    SPECIES_META,
    ...defaultModel,
};
