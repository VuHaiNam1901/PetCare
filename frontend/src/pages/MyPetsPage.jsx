import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  Heart,
  Home,
  LogOut,
  PawPrint,
  Pencil,
  Plus,
  Save,
  ShoppingBag,
  Star,
  TicketPercent,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';
import { useChatPageState } from '../context/ChatPageContext.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { ProductImage } from '../components/ProductCard.jsx';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { formatOrderDate } from '../utils/orders.js';
import { BRAND_NAME } from '../config/branding.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import {
  ACTIVITY_OPTIONS,
  GENDER_OPTIONS,
  PET_SPECIES_OPTIONS,
  activityLabel,
  formatAgeMonths,
  formatWeightKg,
  genderLabel,
  speciesById,
} from '../services/pets.js';
import '../my-orders.css';
import '../my-pets.css';

const emptyFormValues = () => ({
  pet_type_id: '1',
  name: '',
  breed: '',
  age_months: '',
  weight_kg: '',
  gender: 'unknown',
  activity_level: 'medium',
  health_notes: '',
  is_default: false,
});

const valuesFromPet = (pet) => ({
  pet_type_id: String(pet.pet_type_id),
  name: pet.name || '',
  breed: pet.breed || '',
  age_months: pet.age_months ?? '',
  weight_kg: pet.weight_kg ?? '',
  gender: pet.gender || 'unknown',
  activity_level: pet.activity_level || 'medium',
  health_notes: pet.health_notes || '',
  is_default: Boolean(pet.is_default),
});

function buildPayload(values) {
  const name = values.name.trim();
  if (!name) throw new Error('Vui lòng nhập tên thú cưng.');
  if (name.length > 80) throw new Error('Tên thú cưng tối đa 80 ký tự.');

  const breed = values.breed.trim();
  if (breed.length > 80) throw new Error('Giống thú cưng tối đa 80 ký tự.');

  let ageMonths = null;
  if (String(values.age_months).trim() !== '') {
    const rawAge = String(values.age_months).trim();
    if (!/^\d+$/.test(rawAge) || Number(rawAge) > 600) {
      throw new Error('Tuổi thú cưng phải là số nguyên từ 0 đến 600 tháng.');
    }
    ageMonths = Number(rawAge);
  }

  let weightKg = null;
  if (String(values.weight_kg).trim() !== '') {
    const numWeight = Number(String(values.weight_kg).trim());
    if (!Number.isFinite(numWeight) || numWeight <= 0 || numWeight > 250) {
      throw new Error('Cân nặng phải lớn hơn 0 và tối đa 250 kg.');
    }
    weightKg = Number(numWeight.toFixed(2));
  }

  const healthNotes = values.health_notes.trim();
  if (healthNotes.length > 300) throw new Error('Ghi chú sức khỏe tối đa 300 ký tự.');

  return {
    pet_type_id: Number(values.pet_type_id),
    name,
    breed: breed || null,
    age_months: ageMonths,
    weight_kg: weightKg,
    gender: values.gender,
    activity_level: values.activity_level,
    health_notes: healthNotes || null,
    is_default: Boolean(values.is_default),
  };
}

function PetForm({ title, values, onChange, onSubmit, onCancel, saving, error, submitLabel }) {
  const selectedSpecies = speciesById(values.pet_type_id);
  const update = (field, value) => onChange(previous => ({ ...previous, [field]: value }));

  return (
    <form className="my-pets-form-card" onSubmit={onSubmit} noValidate>
      <div className="my-pets-form-header">
        <h2><PawPrint size={18} aria-hidden="true" />{title}</h2>
        <button className="button button-outline" type="button" onClick={onCancel} disabled={saving}>
          <X size={15} aria-hidden="true" />Hủy
        </button>
      </div>

      <div className="my-pets-species-picker" role="radiogroup" aria-label="Chọn loài thú cưng">
        {PET_SPECIES_OPTIONS.map(option => {
          const selected = Number(values.pet_type_id) === option.pet_type_id;
          return (
            <button
              key={option.pet_type_id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`my-pets-species-option${selected ? ' is-selected' : ''}`}
              onClick={() => update('pet_type_id', String(option.pet_type_id))}
              disabled={saving}
            >
              <img src={option.avatar_url} alt={option.name} />
              <span>{option.name}</span>
            </button>
          );
        })}
      </div>

      <div className="my-pets-preset-note">
        <img src={selectedSpecies.avatar_url} alt={selectedSpecies.name} />
        <span>Đang dùng ảnh đại diện mẫu cho loài <strong>{selectedSpecies.name}</strong> (hiện chưa hỗ trợ tải ảnh riêng).</span>
      </div>

      <div className="my-pets-form-grid">
        <div className="my-pets-field">
          <label htmlFor="pet-name">Tên thú cưng *</label>
          <input
            id="pet-name"
            type="text"
            maxLength={80}
            required
            placeholder="Ví dụ: Bông, Mít, Milo..."
            value={values.name}
            onChange={e => update('name', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="my-pets-field">
          <label htmlFor="pet-breed">Giống / Đặc điểm dòng</label>
          <input
            id="pet-breed"
            type="text"
            maxLength={80}
            placeholder="Ví dụ: Poodle, Anh lông ngắn, Betta..."
            value={values.breed}
            onChange={e => update('breed', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="my-pets-field">
          <label htmlFor="pet-age-months">Tuổi (tháng)</label>
          <input
            id="pet-age-months"
            type="number"
            min={0}
            max={600}
            step={1}
            placeholder="Ví dụ: 18"
            value={values.age_months}
            onChange={e => update('age_months', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="my-pets-field">
          <label htmlFor="pet-weight-kg">Cân nặng (kg)</label>
          <input
            id="pet-weight-kg"
            type="number"
            min={0.01}
            max={250}
            step="0.01"
            placeholder="Ví dụ: 4.5"
            value={values.weight_kg}
            onChange={e => update('weight_kg', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="my-pets-field">
          <label htmlFor="pet-gender">Giới tính</label>
          <select
            id="pet-gender"
            value={values.gender}
            onChange={e => update('gender', e.target.value)}
            disabled={saving}
          >
            {GENDER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="my-pets-field">
          <label htmlFor="pet-activity">Mức độ vận động</label>
          <select
            id="pet-activity"
            value={values.activity_level}
            onChange={e => update('activity_level', e.target.value)}
            disabled={saving}
          >
            {ACTIVITY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="my-pets-field my-pets-field-full">
          <label htmlFor="pet-health-notes">Ghi chú sức khỏe / dị ứng / sở thích</label>
          <textarea
            id="pet-health-notes"
            maxLength={300}
            placeholder="Ví dụ: Dễ dị ứng gà, thích pate cá ngừ, đang ăn hạt mềm..."
            value={values.health_notes}
            onChange={e => update('health_notes', e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      <label className="my-pets-checkbox">
        <input
          type="checkbox"
          checked={Boolean(values.is_default)}
          onChange={e => update('is_default', e.target.checked)}
          disabled={saving}
        />
        <span>Đặt làm thú cưng mặc định khi chatbot tư vấn</span>
      </label>

      {error && <p className="my-pets-form-error" role="alert">{error}</p>}

      <div className="my-pets-form-actions">
        <button className="button button-primary" type="submit" disabled={saving}>
          <Save size={15} aria-hidden="true" />
          {saving ? 'Đang lưu...' : submitLabel}
        </button>
        <button className="button button-outline" type="button" onClick={onCancel} disabled={saving}>
          Hủy
        </button>
      </div>
    </form>
  );
}

function DeleteConfirmDialog({ pet, deleting, onConfirm, onCancel }) {
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !deleting) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleting, onCancel]);

  if (!pet) return null;

  return (
    <div className="my-pets-modal-backdrop" role="presentation" onClick={() => !deleting && onCancel()}>
      <div
        className="my-pets-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-pet-title"
        onClick={event => event.stopPropagation()}
      >
        <h2 id="delete-pet-title">Xác nhận xóa hồ sơ thú cưng</h2>
        <p>
          Bạn có chắc muốn xóa hồ sơ <strong>{pet.name}</strong> ({pet.species_name})?
          Thao tác này sẽ ẩn thú cưng khỏi danh sách của bạn nhưng vẫn bảo toàn lịch sử đơn hàng liên quan sau này.
        </p>
        <div className="my-pets-form-actions">
          <button
            className="button my-pets-btn-danger"
            type="button"
            disabled={deleting}
            onClick={onConfirm}
          >
            <Trash2 size={15} aria-hidden="true" />
            {deleting ? 'Đang xóa...' : 'Xác nhận xóa'}
          </button>
          <button className="button button-outline" type="button" disabled={deleting} onClick={onCancel}>
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MyPetsPage({ petId = null }) {
  const { user, authLoading, busy, getPets, getPetProducts, createPet, updatePet, setDefaultPet, deletePet, logout, notify } = useCommerce();
  const { ready: vouchersReady } = useVoucherReadiness();

  const isDetailRoute = petId !== null && petId !== '';
  const validDetailId = isDetailRoute && /^[1-9]\d*$/.test(String(petId));
  const ownerId = user?.role === 'user' ? Number(user.user_id) : null;

  const [pets, setPets] = useState([]);
  const [detailPet, setDetailPet] = useState(null);
  const [petHistory, setPetHistory] = useState({ completed_products: [], pending_products: [], summary: null });
  const [speciesFilter, setSpeciesFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notReadyError, setNotReadyError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const [formMode, setFormMode] = useState(null); // null | 'create' | 'edit'
  const [editingPetId, setEditingPetId] = useState(null);
  const [formValues, setFormValues] = useState(emptyFormValues);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [confirmDeletePet, setConfirmDeletePet] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionBusyId, setActionBusyId] = useState(null);
  const [revision, setRevision] = useState(0);

  const refs = useRef({ getPets, getPetProducts });
  refs.current = { getPets, getPetProducts };

  useEffect(() => {
    const previous = document.title;
    document.title = isDetailRoute
      ? `${detailPet ? detailPet.name : 'Chi tiết thú cưng'} | ${BRAND_NAME}`
      : `Thú cưng của tôi | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, [isDetailRoute, detailPet?.name]);

  useEffect(() => {
    if (authLoading || user) return;
    const rawTarget = isDetailRoute ? `/my-pets/${petId}` : '/my-pets';
    const returnTo = safeReturnUrl(rawTarget, '/my-pets');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id, isDetailRoute, petId]);

  useEffect(() => {
    if (authLoading || !ownerId) {
      if (!authLoading && user && user.role !== 'user') setLoading(false);
      return;
    }

    if (isDetailRoute && !validDetailId) {
      setDetailPet(null);
      setNotFound(true);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setNotReadyError('');
    setNotFound(false);

    const run = async () => {
      try {
        if (isDetailRoute) {
          const data = await refs.current.getPetProducts(Number(petId), { signal: controller.signal });
          if (controller.signal.aborted) return;
          setDetailPet(data.pet || null);
          setPetHistory({
            completed_products: Array.isArray(data.completed_products) ? data.completed_products : [],
            pending_products: Array.isArray(data.pending_products) ? data.pending_products : [],
            summary: data.summary || null,
          });
        } else {
          const data = await refs.current.getPets({ signal: controller.signal });
          if (controller.signal.aborted) return;
          setPets(data.pets || []);
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError' || error?.obsolete) return;
        if (error?.status === 503 || error?.code === 'PET_PROFILE_NOT_READY') {
          setNotReadyError(error.message || 'Tính năng Hồ sơ thú cưng chưa được khởi tạo cơ sở dữ liệu.');
        } else if (isDetailRoute && error?.status === 404) {
          setNotFound(true);
        } else {
          setLoadError(error.message || 'Không tải được hồ sơ thú cưng.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void run();
    return () => controller.abort();
  }, [authLoading, ownerId, isDetailRoute, validDetailId, petId, revision]);

  const pageBusy = saving || deleting || actionBusyId !== null;
  const pagePhase = authLoading || loading
    ? 'loading'
    : (notFound ? 'not_found' : (loadError || notReadyError ? 'error' : 'ready'));

  useChatPageState(
    isDetailRoute
      ? { phase: pagePhase, editing: formMode === 'edit', has_pets: Boolean(detailPet), busy: pageBusy }
      : { phase: pagePhase, has_pets: pets.length > 0, busy: pageBusy }
  );

  const visiblePets = speciesFilter
    ? pets.filter(item => Number(item.pet_type_id) === Number(speciesFilter))
    : pets;

  const openCreateForm = () => {
    setFormMode('create');
    setEditingPetId(null);
    setFormValues({
      ...emptyFormValues(),
      pet_type_id: speciesFilter || '1',
      is_default: pets.length === 0,
    });
    setFormError('');
  };

  const openEditForm = (pet) => {
    setFormMode('edit');
    setEditingPetId(pet.pet_id);
    setFormValues(valuesFromPet(pet));
    setFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const closeForm = () => {
    setFormMode(null);
    setEditingPetId(null);
    setFormError('');
  };

  const handleSubmitForm = async (event) => {
    event.preventDefault();
    setFormError('');
    let payload;
    try {
      payload = buildPayload(formValues);
    } catch (error) {
      setFormError(error.message);
      return;
    }

    setSaving(true);
    try {
      if (formMode === 'create') {
        const result = await createPet(payload);
        notify(result.message || 'Đã thêm hồ sơ thú cưng.');
        closeForm();
        setRevision(v => v + 1);
      } else if (formMode === 'edit' && editingPetId) {
        const result = await updatePet(editingPetId, payload);
        notify(result.message || 'Đã cập nhật hồ sơ thú cưng.');
        if (isDetailRoute && result.pet) setDetailPet(result.pet);
        closeForm();
        setRevision(v => v + 1);
      }
    } catch (error) {
      if (!error?.obsolete) {
        setFormError(error.message || 'Không lưu được hồ sơ thú cưng.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (pet) => {
    setActionBusyId(pet.pet_id);
    try {
      const result = await setDefaultPet(pet.pet_id);
      notify(result.message || `Đã đặt ${pet.name} làm thú cưng mặc định.`);
      if (isDetailRoute && result.pet) setDetailPet(result.pet);
      setRevision(v => v + 1);
    } catch (error) {
      if (!error?.obsolete) notify(error.message || 'Chưa đặt được thú cưng mặc định.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeletePet) return;
    setDeleting(true);
    try {
      const targetId = confirmDeletePet.pet_id;
      const result = await deletePet(targetId);
      setConfirmDeletePet(null);
      notify(result.message || 'Đã xóa hồ sơ thú cưng.');
      if (isDetailRoute) {
        window.location.assign('/my-pets');
      } else {
        if (editingPetId === targetId) closeForm();
        setRevision(v => v + 1);
      }
    } catch (error) {
      if (!error?.obsolete) notify(error.message || 'Không xóa được hồ sơ thú cưng.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="container my-orders-page my-pets-page">
      <nav className="catalog-breadcrumbs" aria-label="Đường dẫn">
        <a href="/"><Home size={14} aria-hidden="true" />Trang chủ</a>
        <ChevronRight size={13} aria-hidden="true" />
        {isDetailRoute ? (
          <>
            <a href="/my-pets">Thú cưng của tôi</a>
            <ChevronRight size={13} aria-hidden="true" />
            <span aria-current="page">{detailPet?.name || 'Chi tiết thú cưng'}</span>
          </>
        ) : (
          <span aria-current="page">Thú cưng của tôi</span>
        )}
      </nav>

      <div className="my-orders-page-heading">
        <div>
          <p className="my-orders-eyebrow">HỒ SƠ THÚ CƯNG THÔNG MINH</p>
          <h1>{isDetailRoute ? (detailPet?.name || 'Chi tiết thú cưng') : 'Thú cưng của tôi'}</h1>
          <p>Quản lý thông tin các bé thú cưng để chatbot tư vấn đúng loài, đúng nhu cầu.</p>
        </div>
        <div className="my-pets-heading-actions">
          {!isDetailRoute && ownerId && !notReadyError && (
            <button
              className="button button-primary"
              type="button"
              onClick={openCreateForm}
              disabled={pageBusy}
            >
              <Plus size={16} aria-hidden="true" />Thêm thú cưng
            </button>
          )}
          <a className="button button-outline my-orders-shop" href="/products">
            <ShoppingBag size={16} aria-hidden="true" />Tiếp tục mua sắm
          </a>
        </div>
      </div>

      {authLoading || !user ? (
        <section className="my-pets-state" role="status">
          <PawPrint size={34} aria-hidden="true" />
          <p>Đang kiểm tra đăng nhập...</p>
        </section>
      ) : user.role !== 'user' ? (
        <section className="my-pets-state">
          <UserRound size={36} aria-hidden="true" />
          <h2>Hồ sơ thú cưng dành cho tài khoản khách hàng</h2>
          <p>Vui lòng đăng nhập bằng tài khoản khách hàng để thêm và quản lý thú cưng của bạn.</p>
        </section>
      ) : (
        <div className="my-orders-layout">
          <aside className="my-orders-account" aria-label="Tài khoản khách hàng">
            <div className="my-orders-profile">
              <span><UserRound size={26} aria-hidden="true" /></span>
              <div>
                <small>Xin chào,</small>
                <strong>{user.full_name || user.email}</strong>
              </div>
            </div>
            <nav aria-label="Tài khoản">
              <a href="/profile"><UserRound size={18} aria-hidden="true" /><span>Thông tin cá nhân</span></a>
              <a href="/my-pets" aria-current={!isDetailRoute ? 'page' : undefined}>
                <PawPrint size={18} aria-hidden="true" />
                <span>Thú cưng của tôi</span>
                <ChevronRight size={14} aria-hidden="true" />
              </a>
              <a href="/my-orders"><ClipboardList size={18} aria-hidden="true" /><span>Đơn hàng của tôi</span></a>
              {vouchersReady && (
                <a href="/my-vouchers"><TicketPercent size={18} aria-hidden="true" /><span>Voucher của tôi</span></a>
              )}
              <a href="/wishlist"><Heart size={18} aria-hidden="true" /><span>Sản phẩm yêu thích</span></a>
              <button
                className="my-orders-account-logout"
                type="button"
                disabled={busy}
                onClick={() => logout().catch(error => notify(error.message))}
              >
                <LogOut size={18} aria-hidden="true" />
                <span>Đăng xuất</span>
              </button>
            </nav>
          </aside>

          <section className="my-orders-content" aria-label="Quản lý hồ sơ thú cưng">
            {formMode && (
              <PetForm
                title={formMode === 'create' ? 'Thêm thú cưng mới' : 'Chỉnh sửa hồ sơ thú cưng'}
                values={formValues}
                onChange={setFormValues}
                onSubmit={handleSubmitForm}
                onCancel={closeForm}
                saving={saving}
                error={formError}
                submitLabel={formMode === 'create' ? 'Lưu thú cưng' : 'Lưu thay đổi'}
              />
            )}

            {loading ? (
              <section className="my-pets-state" role="status">
                <PawPrint size={34} aria-hidden="true" />
                <p>Đang tải hồ sơ thú cưng...</p>
              </section>
            ) : notReadyError ? (
              <ErrorNotice
                title="Hồ sơ thú cưng chưa được kích hoạt"
                message={`${notReadyError} Vui lòng áp dụng migration 011-user-pets trên cơ sở dữ liệu khi sẵn sàng.`}
                onRetry={() => setRevision(v => v + 1)}
              />
            ) : loadError ? (
              <ErrorNotice
                title="Chưa tải được hồ sơ thú cưng"
                message={loadError}
                onRetry={() => setRevision(v => v + 1)}
              />
            ) : isDetailRoute ? (
              notFound || !detailPet ? (
                <section className="my-pets-state">
                  <PawPrint size={36} aria-hidden="true" />
                  <h2>Không tìm thấy hồ sơ thú cưng</h2>
                  <p>Hồ sơ có thể đã bị xóa hoặc không thuộc tài khoản hiện tại của bạn.</p>
                  <a className="button button-primary" href="/my-pets">
                    <ArrowLeft size={15} aria-hidden="true" />Quay lại danh sách
                  </a>
                </section>
              ) : (
                <article className="my-pet-detail-card">
                  <div className="my-pet-detail-hero">
                    <img
                      className="my-pet-detail-avatar"
                      src={detailPet.avatar_url}
                      alt={`${detailPet.name} - ${detailPet.species_name}`}
                    />
                    <div className="my-pet-identity">
                      <div className="my-pet-title-row">
                        <h2>{detailPet.name}</h2>
                        {detailPet.is_default && (
                          <span className="my-pet-default-badge">
                            <Star size={12} aria-hidden="true" />Mặc định
                          </span>
                        )}
                      </div>
                      <p className="my-pet-species-line">
                        {detailPet.species_name}{detailPet.breed ? ` · ${detailPet.breed}` : ''}
                      </p>
                    </div>
                  </div>

                  <dl className="my-pet-meta">
                    <div>
                      <dt>Loài</dt>
                      <dd>{detailPet.species_name}</dd>
                    </div>
                    <div>
                      <dt>Giống</dt>
                      <dd>{detailPet.breed || 'Chưa cập nhật'}</dd>
                    </div>
                    <div>
                      <dt>Tuổi</dt>
                      <dd>{formatAgeMonths(detailPet.age_months)}</dd>
                    </div>
                    <div>
                      <dt>Cân nặng</dt>
                      <dd>{formatWeightKg(detailPet.weight_kg)}</dd>
                    </div>
                    <div>
                      <dt>Giới tính</dt>
                      <dd>{genderLabel(detailPet.gender)}</dd>
                    </div>
                    <div>
                      <dt>Vận động</dt>
                      <dd>{activityLabel(detailPet.activity_level)}</dd>
                    </div>
                  </dl>

                  {detailPet.health_notes && (
                    <p className="my-pet-notes">
                      <strong>Ghi chú sức khỏe / sở thích: </strong>
                      {detailPet.health_notes}
                    </p>
                  )}

                  <div className="my-pets-card-actions">
                    <a className="button button-outline" href="/my-pets">
                      <ArrowLeft size={15} aria-hidden="true" />Danh sách
                    </a>
                    <button
                      className="button button-primary"
                      type="button"
                      onClick={() => openEditForm(detailPet)}
                      disabled={pageBusy}
                    >
                      <Pencil size={15} aria-hidden="true" />Chỉnh sửa
                    </button>
                    {!detailPet.is_default && (
                      <button
                        className="button button-outline"
                        type="button"
                        onClick={() => handleSetDefault(detailPet)}
                        disabled={pageBusy}
                      >
                        <Star size={15} aria-hidden="true" />
                        {actionBusyId === detailPet.pet_id ? 'Đang đặt...' : 'Đặt mặc định'}
                      </button>
                    )}
                    <button
                      className="button button-outline my-pets-btn-danger"
                      type="button"
                      onClick={() => setConfirmDeletePet(detailPet)}
                      disabled={pageBusy}
                    >
                      <Trash2 size={15} aria-hidden="true" />Xóa
                    </button>
                  </div>

                  <section className="my-pet-history-section" aria-labelledby="my-pet-history-title">
                    <div className="my-pet-history-heading">
                      <div>
                        <h3 id="my-pet-history-title">Lịch sử sản phẩm đã mua</h3>
                        <p>Các đơn hàng hoàn tất chỉ ghi nhận sản phẩm đã mua cho {detailPet.name}, không tự suy luận bé đã sử dụng.</p>
                      </div>
                    </div>

                    {petHistory.completed_products.length > 0 ? (
                      <div className="my-pet-history-group">
                        <h4>Đã mua hoàn tất ({petHistory.completed_products.length})</h4>
                        <ul className="my-pet-history-list">
                          {petHistory.completed_products.map(item => {
                            const src = resolveImageUrl(item.image_url);
                            return (
                              <li key={`${item.order_detail_id}-completed`} className="my-pet-history-item">
                                <a className="my-pet-history-image" href={`/products/${item.product_id}`}>
                                  <ProductImage key={src} source={src} name={item.product_name} width={58} height={58} />
                                </a>
                                <div className="my-pet-history-copy">
                                  <div className="my-pet-history-title-row">
                                    <a href={`/products/${item.product_id}`}>{item.product_name}</a>
                                    <span className="my-pet-history-badge is-completed">Đã mua hoàn tất</span>
                                  </div>
                                  <p className="my-pet-history-meta">
                                    Số lượng: <strong>{item.quantity}</strong> · Giá lúc mua: <strong>{item.unit_price != null ? formatPrice(item.unit_price) : 'Chưa có'}</strong>
                                  </p>
                                  <p className="my-pet-history-meta">
                                    Đơn <a href={`/my-orders/${item.order_id}`}>#{item.order_id}</a>
                                    {item.order_date ? ` · Ngày mua ${formatOrderDate(item.order_date)}` : ''}
                                  </p>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : (
                      <div className="my-pet-history-empty">
                        <p>Chưa có sản phẩm nào trong đơn hàng hoàn tất được liên kết cho {detailPet.name}.</p>
                        {petHistory.pending_products.length === 0 && (
                          <a className="button button-outline" href="/products">
                            <ShoppingBag size={14} aria-hidden="true" />Khám phá sản phẩm
                          </a>
                        )}
                      </div>
                    )}

                    {petHistory.pending_products.length > 0 && (
                      <div className="my-pet-history-group">
                        <h4>Đơn đang xử lý / chưa hoàn tất ({petHistory.pending_products.length})</h4>
                        <ul className="my-pet-history-list">
                          {petHistory.pending_products.map(item => {
                            const src = resolveImageUrl(item.image_url);
                            return (
                              <li key={`${item.order_detail_id}-pending`} className="my-pet-history-item is-pending">
                                <a className="my-pet-history-image" href={`/products/${item.product_id}`}>
                                  <ProductImage key={src} source={src} name={item.product_name} width={58} height={58} />
                                </a>
                                <div className="my-pet-history-copy">
                                  <div className="my-pet-history-title-row">
                                    <a href={`/products/${item.product_id}`}>{item.product_name}</a>
                                    <span className="my-pet-history-badge is-pending">
                                      {item.order_status}{item.payment_status ? ` · ${item.payment_status}` : ''}
                                    </span>
                                  </div>
                                  <p className="my-pet-history-meta">
                                    Số lượng: <strong>{item.quantity}</strong> · Giá lúc đặt: <strong>{item.unit_price != null ? formatPrice(item.unit_price) : 'Chưa có'}</strong>
                                  </p>
                                  <p className="my-pet-history-meta">
                                    Đơn <a href={`/my-orders/${item.order_id}`}>#{item.order_id}</a>
                                    {item.order_date ? ` · Đặt ngày ${formatOrderDate(item.order_date)}` : ''}
                                  </p>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </section>
                </article>
              )
            ) : (
              <>
                <div className="my-pets-toolbar">
                  <div className="my-pets-toolbar-top">
                    <div>
                      <h2>Danh sách thú cưng</h2>
                      <p aria-live="polite">
                        {pets.length} hồ sơ đang hoạt động
                        {speciesFilter ? ` · Đang lọc: ${speciesById(speciesFilter).name}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="my-pets-species-filters" role="group" aria-label="Lọc theo loài thú cưng">
                    <button
                      type="button"
                      className={`my-pets-filter-chip${speciesFilter === '' ? ' is-active' : ''}`}
                      onClick={() => setSpeciesFilter('')}
                    >
                      Tất cả ({pets.length})
                    </button>
                    {PET_SPECIES_OPTIONS.map(option => {
                      const count = pets.filter(item => Number(item.pet_type_id) === option.pet_type_id).length;
                      const active = speciesFilter === String(option.pet_type_id);
                      return (
                        <button
                          key={option.pet_type_id}
                          type="button"
                          className={`my-pets-filter-chip${active ? ' is-active' : ''}`}
                          onClick={() => setSpeciesFilter(active ? '' : String(option.pet_type_id))}
                        >
                          {option.name} ({count})
                        </button>
                      );
                    })}
                  </div>
                </div>

                {!visiblePets.length ? (
                  <section className="my-pets-state">
                    <PawPrint size={40} strokeWidth={1.5} aria-hidden="true" />
                    <h2>
                      {pets.length
                        ? `Chưa có thú cưng thuộc nhóm ${speciesById(speciesFilter).name}`
                        : 'Bạn chưa thêm thú cưng nào'}
                    </h2>
                    <p>
                      {pets.length
                        ? 'Thử chọn loài khác hoặc thêm một hồ sơ thú cưng mới cho loài này.'
                        : 'Lưu tên, loài, cân nặng và sở thích của các bé để chatbot PetCareShop gợi ý nhanh hơn mà không cần nhập lại.'}
                    </p>
                    <button className="button button-primary" type="button" onClick={openCreateForm}>
                      <Plus size={16} aria-hidden="true" />Thêm thú cưng
                    </button>
                  </section>
                ) : (
                  <div className="my-pets-grid">
                    {visiblePets.map(pet => (
                      <article
                        key={pet.pet_id}
                        className={`my-pet-card${pet.is_default ? ' is-default' : ''}`}
                      >
                        <div className="my-pet-card-top">
                          <img
                            className="my-pet-avatar"
                            src={pet.avatar_url}
                            alt={`${pet.name} - ${pet.species_name}`}
                          />
                          <div className="my-pet-identity">
                            <div className="my-pet-title-row">
                              <h3>{pet.name}</h3>
                              {pet.is_default && (
                                <span className="my-pet-default-badge">
                                  <Star size={11} aria-hidden="true" />Mặc định
                                </span>
                              )}
                            </div>
                            <p className="my-pet-species-line">
                              {pet.species_name}{pet.breed ? ` · ${pet.breed}` : ''}
                            </p>
                          </div>
                        </div>

                        <dl className="my-pet-meta">
                          <div>
                            <dt>Tuổi</dt>
                            <dd>{formatAgeMonths(pet.age_months)}</dd>
                          </div>
                          <div>
                            <dt>Cân nặng</dt>
                            <dd>{formatWeightKg(pet.weight_kg)}</dd>
                          </div>
                          <div>
                            <dt>Giới tính</dt>
                            <dd>{genderLabel(pet.gender)}</dd>
                          </div>
                          <div>
                            <dt>Vận động</dt>
                            <dd>{activityLabel(pet.activity_level)}</dd>
                          </div>
                        </dl>

                        {pet.health_notes && (
                          <p className="my-pet-notes">{pet.health_notes}</p>
                        )}

                        <div className="my-pets-card-actions">
                          <a className="button button-outline" href={`/my-pets/${pet.pet_id}`}>
                            <Eye size={14} aria-hidden="true" />Xem chi tiết
                          </a>
                          <button
                            className="button button-outline"
                            type="button"
                            onClick={() => openEditForm(pet)}
                            disabled={pageBusy}
                          >
                            <Pencil size={14} aria-hidden="true" />Chỉnh sửa
                          </button>
                          {!pet.is_default && (
                            <button
                              className="button button-outline"
                              type="button"
                              onClick={() => handleSetDefault(pet)}
                              disabled={pageBusy}
                            >
                              <Star size={14} aria-hidden="true" />
                              {actionBusyId === pet.pet_id ? 'Đang đặt...' : 'Đặt mặc định'}
                            </button>
                          )}
                          <button
                            className="button button-outline my-pets-btn-danger"
                            type="button"
                            onClick={() => setConfirmDeletePet(pet)}
                            disabled={pageBusy}
                          >
                            <Trash2 size={14} aria-hidden="true" />Xóa
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      <DeleteConfirmDialog
        pet={confirmDeletePet}
        deleting={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeletePet(null)}
      />
    </div>
  );
}
