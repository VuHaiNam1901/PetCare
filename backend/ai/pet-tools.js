const defaultPetModel = require('../models/user-pet');

const normalizeName = (value) => defaultPetModel.normalizePetName(value);

const sanitizeNotes = (value) => {
    if (!value || typeof value !== 'string') return null;
    const cleaned = value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email ẩn]')
        .replace(/(?:\+?84|0)(?:[\s.-]?\d){8,10}/g, '[sđt ẩn]')
        .trim();
    return cleaned || null;
};

function projectPetForAi(pet) {
    return {
        pet_id: Number(pet.pet_id),
        name: pet.name,
        species_id: Number(pet.pet_type_id),
        species_slug: pet.species_slug,
        species_name: pet.species_name,
        breed: pet.breed ?? null,
        age_months: pet.age_months ?? null,
        weight_kg: pet.weight_kg ?? null,
        gender: pet.gender || 'unknown',
        activity_level: pet.activity_level || 'medium',
        health_notes: sanitizeNotes(pet.health_notes),
        is_default: Boolean(pet.is_default),
    };
}

function createPetTools({ petModel = defaultPetModel } = {}) {
    return {
        async execute(args = {}, { userId } = {}) {
            if (!Number.isInteger(userId) || userId <= 0) {
                return {
                    authenticated: false,
                    ready: true,
                    total: 0,
                    default_pet_id: null,
                    ambiguous_name: false,
                    needs_selection: false,
                    matched_pets: [],
                    pets: [],
                    purchase_history_available: false,
                    note: 'Người dùng chưa đăng nhập nên chưa có hồ sơ thú cưng.',
                };
            }

            const rawNameQuery = typeof args?.name_query === 'string' ? args.name_query.trim().slice(0, 80) : '';
            const requestedIds = Array.isArray(args?.pet_ids)
                ? [...new Set(args.pet_ids.filter(id => Number.isInteger(id) && id > 0))].slice(0, 10)
                : [];

            let allPets;
            try {
                allPets = await petModel.listByUser(userId);
            } catch (error) {
                if (error?.code === 'PET_PROFILE_NOT_READY') {
                    return {
                        authenticated: true,
                        ready: false,
                        total: 0,
                        default_pet_id: null,
                        ambiguous_name: false,
                        needs_selection: false,
                        matched_pets: [],
                        pets: [],
                        purchase_history_available: false,
                        note: 'Tính năng Hồ sơ thú cưng chưa được khởi tạo cơ sở dữ liệu.',
                    };
                }
                throw error;
            }

            const pets = allPets.map(projectPetForAi);
            const defaultPet = pets.find(pet => pet.is_default) || null;
            const defaultPetId = defaultPet ? defaultPet.pet_id : null;

            let matchedPets = [];
            let ambiguousName = false;

            if (requestedIds.length > 0) {
                const idSet = new Set(requestedIds);
                matchedPets = pets.filter(pet => idSet.has(pet.pet_id));
            } else if (rawNameQuery) {
                const normalizedQuery = normalizeName(rawNameQuery);
                if (normalizedQuery) {
                    matchedPets = pets.filter(pet => normalizeName(pet.name) === normalizedQuery);
                    if (matchedPets.length === 0 && normalizedQuery.length >= 2) {
                        matchedPets = pets.filter(pet => {
                            const target = normalizeName(pet.name);
                            return target.includes(normalizedQuery) || normalizedQuery.includes(target);
                        });
                    }
                    ambiguousName = matchedPets.length > 1;
                }
            } else if (defaultPet) {
                matchedPets = [defaultPet];
            } else if (pets.length === 1) {
                matchedPets = [pets[0]];
            }

            const needsSelection =
                !ambiguousName &&
                !rawNameQuery &&
                requestedIds.length === 0 &&
                !defaultPetId &&
                pets.length > 1;

            let note = 'Chỉ sử dụng thông tin có thật trong hồ sơ thú cưng và kết quả catalog.';
            if (ambiguousName) {
                note = `Có ${matchedPets.length} thú cưng trùng tên "${rawNameQuery}". Hãy hỏi lại khách để xác định đúng cá thể trước khi chốt tư vấn.`;
            } else if (needsSelection) {
                note = 'Tài khoản có nhiều thú cưng và chưa đặt thú cưng mặc định. Hãy hỏi lại khách muốn tư vấn cho bé nào hoặc tìm tổng quát nếu khách hỏi nhiều bé.';
            } else if (pets.length === 0) {
                note = 'Tài khoản chưa lưu hồ sơ thú cưng nào.';
            } else {
                note = 'Có thể dùng get_pet_purchase_history để đọc lịch sử sản phẩm đã mua gắn theo từng thú cưng. Đơn hoàn tất chỉ xác nhận đã mua, không tự khẳng định bé đã ăn hoặc đã sử dụng.';
            }

            return {
                authenticated: true,
                ready: true,
                total: pets.length,
                default_pet_id: defaultPetId,
                ambiguous_name: ambiguousName,
                needs_selection: needsSelection,
                matched_pets: matchedPets.slice(0, 10),
                pets: pets.slice(0, 20),
                purchase_history_available: true,
                note,
            };
        },

        async executePurchaseHistory(args = {}, { userId, productRepository } = {}) {
            if (!Number.isInteger(userId) || userId <= 0) {
                return {
                    authenticated: false,
                    ready: true,
                    ambiguous_name: false,
                    needs_selection: false,
                    matched_pets: [],
                    histories: [],
                    catalog_products: [],
                    confirmed_consumption: false,
                    note: 'Người dùng chưa đăng nhập nên không thể truy xuất lịch sử mua hàng theo thú cưng.',
                };
            }

            let allPets;
            try {
                allPets = await petModel.listByUser(userId);
            } catch (error) {
                if (error?.code === 'PET_PROFILE_NOT_READY') {
                    return {
                        authenticated: true,
                        ready: false,
                        ambiguous_name: false,
                        needs_selection: false,
                        matched_pets: [],
                        histories: [],
                        catalog_products: [],
                        confirmed_consumption: false,
                        note: 'Tính năng Hồ sơ thú cưng chưa được khởi tạo cơ sở dữ liệu.',
                    };
                }
                throw error;
            }

            const pets = allPets.map(projectPetForAi);
            const defaultPet = pets.find(pet => pet.is_default) || null;
            const defaultPetId = defaultPet ? defaultPet.pet_id : null;

            const singleId = Number.isInteger(args?.pet_id) && args.pet_id > 0 ? args.pet_id : null;
            const requestedIds = Array.isArray(args?.pet_ids)
                ? [...new Set(args.pet_ids.filter(id => Number.isInteger(id) && id > 0))].slice(0, 6)
                : [];
            if (singleId && !requestedIds.includes(singleId)) requestedIds.unshift(singleId);

            const nameQueries = [];
            if (typeof args?.name_query === 'string' && args.name_query.trim()) {
                nameQueries.push(args.name_query.trim().slice(0, 80));
            }
            if (Array.isArray(args?.pet_names)) {
                for (const raw of args.pet_names) {
                    if (typeof raw === 'string' && raw.trim()) nameQueries.push(raw.trim().slice(0, 80));
                }
            }
            const uniqueNames = [...new Set(nameQueries)].slice(0, 6);
            const includePending = args?.include_pending !== false;

            const matchByName = (query) => {
                const normalized = normalizeName(query);
                if (!normalized) return [];
                const exact = pets.filter(pet => normalizeName(pet.name) === normalized);
                if (exact.length > 0) return exact;
                if (normalized.length < 2) return [];
                return pets.filter(pet => {
                    const target = normalizeName(pet.name);
                    return target.includes(normalized) || normalized.includes(target);
                });
            };

            let targetPets = [];
            let ambiguousName = false;
            const ambiguousGroups = [];

            if (requestedIds.length > 0) {
                const idSet = new Set(requestedIds);
                targetPets = pets.filter(pet => idSet.has(pet.pet_id));
            } else if (uniqueNames.length > 0) {
                const picked = new Map();
                for (const name of uniqueNames) {
                    const found = matchByName(name);
                    if (found.length > 1) {
                        ambiguousName = true;
                        ambiguousGroups.push(name);
                        for (const item of found) picked.set(item.pet_id, item);
                    } else if (found.length === 1) {
                        picked.set(found[0].pet_id, found[0]);
                    }
                }
                targetPets = [...picked.values()];
            } else if (args?.include_default === true && defaultPet) {
                targetPets = [defaultPet];
            } else {
                targetPets = pets.slice(0, 4);
            }

            if (ambiguousName) {
                return {
                    authenticated: true,
                    ready: true,
                    total_pets: pets.length,
                    default_pet_id: defaultPetId,
                    ambiguous_name: true,
                    ambiguous_names: ambiguousGroups,
                    needs_selection: false,
                    matched_pets: targetPets.slice(0, 10),
                    histories: [],
                    catalog_products: [],
                    confirmed_consumption: false,
                    note: `Tìm thấy nhiều thú cưng trùng tên (${ambiguousGroups.join(', ')}). Hãy hỏi lại khách muốn kiểm tra cho bé nào kèm loài, giống, tuổi, cân nặng để phân biệt trước khi dùng lịch sử mua.`,
                };
            }

            const histories = [];
            const catalogCandidateIds = [];
            const seenProductIds = new Set();

            for (const pet of targetPets.slice(0, 4)) {
                let historyData;
                try {
                    historyData = await petModel.getPetPurchaseHistory(userId, pet.pet_id, { limit: 15 });
                } catch (error) {
                    if (error?.code === 'PET_NOT_FOUND') continue;
                    throw error;
                }

                const compactRow = (item) => ({
                    order_id: item.order_id,
                    order_date: item.order_date,
                    order_status: item.order_status,
                    payment_status: item.payment_status,
                    product_id: item.product_id,
                    product_name: item.product_name,
                    quantity: item.quantity,
                    price_at_purchase: item.unit_price,
                    current_price: item.current_price,
                    current_stock_quantity: item.current_stock_quantity,
                    product_status: item.product_status,
                    currently_available: item.currently_available,
                });

                const completed = historyData.completed_products.slice(0, 6).map(compactRow);
                const pending = includePending ? historyData.pending_products.slice(0, 4).map(compactRow) : [];

                for (const row of completed) {
                    if (!seenProductIds.has(row.product_id) && catalogCandidateIds.length < 6) {
                        seenProductIds.add(row.product_id);
                        catalogCandidateIds.push(row.product_id);
                    }
                }

                histories.push({
                    pet,
                    has_completed_history: historyData.completed_products.length > 0,
                    has_pending_history: historyData.pending_products.length > 0,
                    summary: historyData.summary,
                    completed_purchases: completed,
                    pending_purchases: pending,
                });
            }

            let catalogProducts = [];
            if (catalogCandidateIds.length > 0 && typeof productRepository?.getByIds === 'function') {
                try {
                    catalogProducts = await productRepository.getByIds(catalogCandidateIds);
                } catch {
                    catalogProducts = [];
                }
            }

            let note = 'Đơn hoàn tất chỉ xác nhận khách đã mua sản phẩm cho bé; không tự khẳng định bé đã ăn/sử dụng hoặc sắp hết nếu khách chưa nói.';
            if (pets.length === 0) {
                note = 'Tài khoản chưa có hồ sơ thú cưng nào.';
            } else if (histories.length === 0 && uniqueNames.length > 0) {
                note = `Không tìm thấy thú cưng tên "${uniqueNames.join(', ')}" trong hồ sơ của tài khoản hiện tại.`;
            } else if (histories.every(entry => !entry.has_completed_history && !entry.has_pending_history)) {
                note = 'Chưa tìm thấy lịch sử mua hàng nào được gắn cho các thú cưng này. Hãy nói rõ chưa có lịch sử mua cho bé và có thể dùng search_products theo loài để gợi ý.';
            }

            return {
                authenticated: true,
                ready: true,
                total_pets: pets.length,
                default_pet_id: defaultPetId,
                ambiguous_name: false,
                needs_selection: !uniqueNames.length && !requestedIds.length && args?.include_default !== true && pets.length > 1 && !defaultPetId,
                matched_pets: targetPets.slice(0, 10),
                histories,
                catalog_products: catalogProducts,
                confirmed_consumption: false,
                note,
            };
        },
    };
}

module.exports = { createPetTools, projectPetForAi };
