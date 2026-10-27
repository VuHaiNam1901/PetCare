const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, redactPersonal, rejectionCode, REJECTION_CODES } = require('../ai/grounding');

// Source-boundary regressions use injected plans and catalog rows only. They
// neither load a Gemini client nor access a database or credentials.
const row = (id, changes = {}) => ({ product_id: id, name: `Bát ăn thử nghiệm ${id}`, price: '125000.00', stock_quantity: 5, status: 'Đang bán', ...changes });
const context = changes => ({ mode: 'product', intent: 'product_search', products: [row(41), row(42, { price: '180000.00' })], search: { maxPrice: '200000.00' }, ...changes });
const plan = (advice, changes = {}) => ({ advice, product_ids: [41], follow_up: null, warnings: [], ...changes });
const response = value => ({ text: JSON.stringify(value), candidates: [{ finishReason: 'STOP' }] });
const validate = (advice, ctx = context(), changes = {}) => validatePlan(response(plan(advice, changes)), ctx);

test('grounding v2: verified Vietnamese budget variants become a neutral reference', async t => {
    for (const advice of [
        'Bạn có thể xem các lựa chọn dưới 200k.',
        'Bạn có thể xem các lựa chọn trong ngân sách 200k.',
        'Với ngân sách 200.000đ, bạn có thể xem các thẻ bên dưới.',
        'Với ngân sách 200 nghìn, bạn có thể cân nhắc các lựa chọn bên dưới.',
        'Bạn có thể xem các lựa chọn tối đa 200.000 đồng.'
    ]) await t.test(advice, () => {
        const result = validate(advice);
        assert.match(result.advice, /trong ngân sách bạn đã nêu/iu);
        assert.doesNotMatch(result.advice, /(?:với|trong|theo) trong ngân sách/iu);
        assert.equal(/200|nghìn/.test(result.advice), false);
        assert.deepEqual(result.product_ids, [41]);
    });
    for (const range of ['100–300 nghìn', 'từ 100k đến 300k', 'ngân sách 100.000đ–300.000đ']) {
        const result = validate(`Bạn có thể xem các lựa chọn ${range}.`, context({ search: { minPrice: '100000.00', maxPrice: '300000.00' } }));
        assert.ok(result.advice.includes('trong ngân sách bạn đã nêu'));
        assert.equal(/100|300/.test(result.advice), false);
    }
});

test('grounding v2: fabricated prices cannot hide behind a verified budget', async t => {
    for (const advice of [
        'Lựa chọn này giá 200k, đúng ngân sách 200k bạn đã nêu.',
        'Bát ăn thử nghiệm 41 có giá 200k, trong ngân sách 200k.',
        'Lựa chọn này có giá dưới 200k.',
        'Mức giá 200.000đ phù hợp ngân sách 200.000đ.',
        'Các lựa chọn dưới 123k rất đáng cân nhắc.',
        'Các lựa chọn trong ngân sách 123.000đ.',
        'Các lựa chọn từ 100k đến 200k.'
    ]) await t.test(advice, () => assert.throws(() => validate(advice), /Generated commercial facts/));
    assert.throws(() => validate('Bạn xem các lựa chọn dưới 200k.', context({ products: [row(41, { price: '250000.00' })] })), /Ungrounded products/);
    assert.throws(() => validate('Bạn xem các lựa chọn trong ngân sách 200k.', context({ search: {} })), /Generated commercial facts/);
});

test('grounding v2: exact selected catalog names and associated prices become card references', () => {
    const advice = 'Bạn có thể xem Bát ăn thử nghiệm 41 với giá 125.000đ. Bạn kiểm tra kích thước trước khi chọn nhé.';
    const result = validate(advice);
    assert.ok(result.advice.includes('lựa chọn thứ nhất'));
    assert.ok(result.advice.includes('được ghi trong thẻ sản phẩm'));
    assert.equal(/Bát ăn|125/.test(result.advice), false);
    assert.deepEqual(result.product_ids, [41]);
    assert.equal(validate('Bạn có thể chọn bát ăn thử nghiệm 41.').advice, 'Bạn có thể chọn lựa chọn thứ nhất trong thẻ sản phẩm.');
});

test('grounding v2: a price match elsewhere in catalog does not prove product association', () => {
    assert.throws(() => validate('Bát ăn thử nghiệm 41 có giá 180k.'), /Generated commercial facts/);
    assert.throws(() => validate('Lựa chọn này có giá 125k.'), /Generated commercial facts/);
    assert.throws(() => validate('Bạn chọn Bát ăn thử nghiệm 42 nhé.'), /Product name belongs in a card/);
    assert.throws(() => validate('Bát ăn thử nghiệm 41 và Bát ăn thử nghiệm 42 đều có giá 125k.', context(), { product_ids: [41, 42] }), /Generated commercial facts/);
});

test('grounding v2: lowercase invented brands and unsupported claims remain rejected', async t => {
    for (const advice of [
        'Mình đề xuất royal canin cho bé.',
        'Bạn nên dùng petmagic cho bé.',
        'Sản phẩm miucat rất tốt cho bé.',
        'Mình có royal canin cho bé.',
        'Shop có thức ăn miucat cho bé.',
        'royal canin rất tốt cho bé.',
        'Royal Canin rất tốt cho bé.',
        'PETMAGIC rất tốt cho bé.',
        'PetMagicUltra rất tốt cho bé.',
        'Lựa chọn này hỗ trợ tiêu hóa và tăng miễn dịch.',
        'Lựa chọn này chứa omega và giàu protein.',
        'Hạt này chứa omega và giàu protein.',
        'Pate này hỗ trợ tiêu hóa.',
        'Hạt đó tăng cường sức khỏe.',
        'Pa tê này chứa protein.',
        'Sản phẩm này chữa viêm da.',
        'Bát ăn thử nghiệm 41 giúp điều trị bệnh thận.'
    ]) await t.test(advice, () => assert.throws(() => validate(advice)));
});

test('grounding v2: negated age and certainty claims are accepted; positive assertions are rejected', async t => {
    const safe = [
        'Mình chưa đủ dữ liệu để xác nhận lựa chọn này phù hợp với mèo 6 tháng tuổi.',
        'Mình không thể khẳng định lựa chọn này an toàn cho mèo con.',
        'Mình không thể đảm bảo lựa chọn này phù hợp với mèo ở độ tuổi bạn nêu.',
        'Mình không chắc lựa chọn này phù hợp với mèo 6 tháng.',
        'Mình chưa đủ dữ liệu về thành phần omega trong lựa chọn này.',
        'Mình chưa đủ thông tin để xác nhận lựa chọn này chứa protein.',
        'Mình không thể xác nhận thành phần omega trong lựa chọn này.',
        'Mình chưa đủ dữ liệu để xác nhận hạt này chứa protein.',
        'Mình không thể khẳng định loại này phù hợp với mèo 6 tháng và an toàn cho mèo con.',
        'Bạn cần kiểm tra nhãn để xác nhận lựa chọn này dành cho độ tuổi nào.',
        'Mình chưa thể xác nhận còn hàng; bạn xem thông tin trong thẻ sản phẩm.'
    ];
    for (const advice of safe) await t.test(advice, () => assert.equal(validate(advice).advice, advice));
    for (const advice of [
        'Lựa chọn này phù hợp với mèo 6 tháng tuổi.',
        'Mèo 6 tháng có thể dùng lựa chọn này.',
        'Lựa chọn này hoàn toàn an toàn cho mèo con.',
        'Mình chưa đủ dữ liệu, nhưng lựa chọn này phù hợp với mèo 6 tháng.',
        'Mình không thể xác nhận, sản phẩm này chứa omega và giàu protein.',
        'Mình không thể khẳng định điều trị được; nhưng lựa chọn này chữa bệnh thận.',
        'Mình không thể xác nhận giá và khẳng định lựa chọn này an toàn cho mèo con.',
        'Mình chưa đủ dữ liệu và đảm bảo hạt này phù hợp với mèo 6 tháng.',
        'Mình không thể xác nhận thành phần nhưng pate này hỗ trợ tiêu hóa.'
    ]) await t.test(advice, () => assert.throws(() => validate(advice), /Unverified suitability or medical advice/));
});

test('grounding v2: disclaimers never permit concrete medication, dosing or diagnosis', async t => {
    for (const advice of [
        'Mình không thể xác nhận, hãy cho mèo uống paracetamol 500 mg.',
        'Bạn không nên tự cho dùng amoxicillin.',
        'Mình chưa đủ dữ liệu, có thể dùng 2 ml thuốc này mỗi ngày.',
        'Mình chưa thể khẳng định nhưng mèo của bạn bị viêm ruột.',
        'Cho bé dùng thuốc với liều 0.5 ml/kg.'
    ]) await t.test(advice, () => assert.throws(() => validate(advice), /Diagnosis or medication instruction/));
    assert.throws(() => validate('Mình chưa thể xác nhận Paracetamol viên nén 500mg.', context({ products: [row(41, { name: 'Paracetamol viên nén 500mg' })] })), /Diagnosis or medication instruction/);
});

test('grounding v2: natural missing-age information and label checks are not suitability assertions', async t => {
    for (const advice of [
        'Mình không có thông tin để xác nhận lựa chọn này phù hợp với mèo 6 tháng tuổi.',
        'Mình chưa có dữ liệu để kết luận lựa chọn này an toàn cho mèo con.',
        'Dữ liệu hiện chưa cung cấp thông tin liệu lựa chọn này phù hợp với mèo 6 tháng tuổi.',
        'Thông tin hiện có chưa cho biết liệu sản phẩm này dùng được cho mèo 6 tháng.',
        'Bạn nên kiểm tra nhãn để đảm bảo lựa chọn này phù hợp với mèo 6 tháng tuổi.',
        'Bạn hãy kiểm tra hướng dẫn trên bao bì để đảm bảo lựa chọn này dành cho mèo con.'
    ]) await t.test(advice, () => assert.equal(validate(advice).advice, advice));
    for (const advice of [
        'Mình không có thông tin để xác nhận giá và khẳng định lựa chọn này an toàn cho mèo con.',
        'Dữ liệu hiện chưa cung cấp thông tin liệu loại này phù hợp nhưng mình đảm bảo lựa chọn này an toàn cho mèo con.',
        'Bạn nên kiểm tra nhãn vì lựa chọn này phù hợp với mèo 6 tháng.',
        'Bạn nên kiểm tra nhãn để đảm bảo lựa chọn này phù hợp với mèo con và khẳng định lựa chọn này hoàn toàn an toàn cho mèo con.',
        'Bạn nên kiểm tra nhãn để đảm bảo lựa chọn này phù hợp với mèo con, và lựa chọn này hoàn toàn an toàn cho mèo con.'
    ]) await t.test(advice, () => assert.throws(() => validate(advice), /Unverified suitability or medical advice/));
    assert.throws(() => validate('Bạn nên kiểm tra nhãn để đảm bảo bé dùng 2 ml thuốc này mỗi ngày.'), /Diagnosis or medication instruction/);
});

test('grounding v2: useful natural care and ordinary capitalized Vietnamese remain accepted', async t => {
    const examples = [
        'Ban Nen giữ nơi ở sạch sẽ và luôn chuẩn bị nước sạch cho bé.',
        'Bạn có thể chia nhỏ bữa ăn và đổi thức ăn từ từ để bé dễ làm quen.',
        'Bạn hãy dọn vụn thức ăn, vệ sinh bát sau khi dùng và giữ chỗ nghỉ của bé khô thoáng.',
        'Bạn có thể dùng khăn mềm để vệ sinh bát và chọn thời điểm yên tĩnh cho bé nghỉ.',
        'Bạn có thể cho bé uống nước sạch sau khi vận động.',
        'Bạn có thể chọn size theo kích thước của bé.',
        'Bạn có thể chọn inox dễ vệ sinh để làm bát ăn.',
        'Bạn nên chọn thức ăn dễ nhai và đổi thức ăn từ từ.',
        'Giữ bát sạch giúp bạn chăm sóc bé thuận tiện hơn.',
        'Mình không thể chẩn đoán hay kê đơn. Bạn nên liên hệ bác sĩ thú y nếu tình trạng kéo dài.',
        'Nếu bé bỏ ăn kéo dài hoặc có dấu hiệu bất thường, bạn nên liên hệ bác sĩ thú y.'
    ];
    for (const advice of examples) await t.test(advice, () => {
        const result = validate(advice, context({ mode: 'care', intent: 'care', products: [], search: undefined }), { product_ids: [] });
        assert.equal(result.advice, advice);
    });
});

test('grounding v2: validation applies equally to advice, follow-up and warnings', () => {
    for (const field of ['advice', 'follow_up', 'warnings']) {
        const malicious = 'Lựa chọn này giá 200k, trong ngân sách 200k.';
        assert.throws(() => validate('Bạn xem các lựa chọn bên dưới.', context(), { [field]: field === 'warnings' ? [malicious] : malicious }), /Generated commercial facts/);
        const budget = 'Bạn muốn chọn loại trong ngân sách 200k?';
        const result = validate('Bạn xem các lựa chọn bên dưới.', context(), { [field]: field === 'warnings' ? [budget] : budget });
        assert.ok((field === 'warnings' ? result[field][0] : result[field]).includes('trong ngân sách bạn đã nêu'));
    }
});

test('grounding v2: strict source, response and schema boundaries remain enforced', () => {
    for (const product_ids of [[999], [41, 41], [41, 42, 43, 44], ['41'], [41.5]]) assert.throws(() => validate('Bạn xem thẻ bên dưới.', context(), { product_ids }), /Ungrounded products/);
    assert.throws(() => validate('Bạn xem thẻ bên dưới.', context({ products: [row(41, { stock_quantity: 0 })] })), /Ungrounded products/);
    assert.equal(validate('Bạn xem thông tin trong thẻ bên dưới.', context({ intent: 'price_stock', products: [row(41, { stock_quantity: 0 })] })).product_ids[0], 41);
    assert.throws(() => validatePlan({ ...response(plan('Bạn xem thẻ bên dưới.')), candidates: [{ finishReason: 'MAX_TOKENS' }] }, context()), /Invalid model response/);
    assert.throws(() => validatePlan(response({ ...plan('Bạn xem thẻ bên dưới.'), price: '1.00' }), context()), /Unexpected model fields/);
    assert.throws(() => validatePlan({ text: '{broken', candidates: [{ finishReason: 'STOP' }] }, context()), /Invalid model response/);
    assert.throws(() => validate('Liên hệ private@example.com.'), /Sensitive output/);
    assert.throws(() => validate('Bạn xem https://example.com.'), /Sensitive output/);
    assert.throws(() => validate('Bạn dùng pet\u200Bmagic nhé.'), /Invalid text/);
    assert.equal(redactPersonal('Email private@example.com; 0912345678; api_key=PRIVATE').includes('PRIVATE'), false);
    assert.equal(rejectionCode(new Error('private untrusted text')), 'Invalid model response');
    for (const code of REJECTION_CODES) assert.equal(rejectionCode(new Error(code)), code);
});
