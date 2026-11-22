const express = require('express');
const defaultPetModel = require('../models/user-pet');

const lazyAuth = () => require('../middleware/auth');

function respondError(res, error) {
    const status = error?.status || 500;
    const body = {
        success: false,
        message: status >= 500 && !error?.code ? 'Lỗi hệ thống khi xử lý hồ sơ thú cưng.' : error.message,
    };
    if (error?.code) body.code = error.code;
    if (error?.retryable) body.retryable = true;
    if (status >= 500 && !error?.status) console.error('Pet route error:', error);
    return res.status(status).json(body);
}

function createPetsRouter({
    petModel = defaultPetModel,
    authenticate = (req, res, next) => lazyAuth().authenticate(req, res, next),
    authorize = (...roles) => (req, res, next) => lazyAuth().authorize(...roles)(req, res, next),
} = {}) {
    const router = express.Router();
    const customerOnly = [authenticate, authorize('user')];

    router.get('/', ...customerOnly, async (req, res) => {
        try {
            const pets = await petModel.listByUser(req.user.user_id, {
                petTypeId: req.query?.pet_type_id,
            });
            return res.json({
                success: true,
                ready: true,
                total: pets.length,
                pets,
            });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.get('/:id/products', ...customerOnly, async (req, res) => {
        try {
            const history = await petModel.getPetPurchaseHistory(req.user.user_id, req.params.id);
            return res.json({ success: true, ...history });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.get('/:id', ...customerOnly, async (req, res) => {
        try {
            const pet = await petModel.getByIdForUser(req.user.user_id, req.params.id);
            return res.json({ success: true, pet });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.post('/', ...customerOnly, async (req, res) => {
        try {
            const pet = await petModel.createPet(req.user.user_id, req.body);
            return res.status(201).json({
                success: true,
                message: 'Đã thêm hồ sơ thú cưng.',
                pet,
            });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.put('/:id', ...customerOnly, async (req, res) => {
        try {
            const pet = await petModel.updatePet(req.user.user_id, req.params.id, req.body);
            return res.json({
                success: true,
                message: 'Đã cập nhật hồ sơ thú cưng.',
                pet,
            });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.patch('/:id/default', ...customerOnly, async (req, res) => {
        try {
            const pet = await petModel.setDefaultPet(req.user.user_id, req.params.id);
            return res.json({
                success: true,
                message: 'Đã đặt làm thú cưng mặc định.',
                pet,
            });
        } catch (error) {
            return respondError(res, error);
        }
    });

    router.delete('/:id', ...customerOnly, async (req, res) => {
        try {
            const removed = await petModel.softDeletePet(req.user.user_id, req.params.id);
            return res.json({
                success: true,
                message: 'Đã xóa hồ sơ thú cưng.',
                ...removed,
            });
        } catch (error) {
            return respondError(res, error);
        }
    });

    return router;
}

const defaultRouter = createPetsRouter();
defaultRouter.createPetsRouter = createPetsRouter;

module.exports = defaultRouter;
