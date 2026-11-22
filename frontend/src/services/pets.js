import { commerceApi } from './commerce.js';

export const PET_SPECIES_OPTIONS = [
  { pet_type_id: 1, slug: 'dog', name: 'Chó', avatar_url: '/images/home/pet-dog.jpg' },
  { pet_type_id: 2, slug: 'cat', name: 'Mèo', avatar_url: '/images/home/pet-cat.jpg' },
  { pet_type_id: 3, slug: 'bird', name: 'Chim', avatar_url: '/images/home/pet-bird.jpg' },
  { pet_type_id: 4, slug: 'fish', name: 'Cá', avatar_url: '/images/home/pet-fish.jpg' },
  { pet_type_id: 5, slug: 'hamster', name: 'Hamster/Chuột', avatar_url: '/images/home/pet-hamster.jpg' },
  { pet_type_id: 6, slug: 'rabbit', name: 'Thỏ', avatar_url: '/images/home/pet-rabbit.jpg' },
];

export const GENDER_OPTIONS = [
  { value: 'unknown', label: 'Chưa rõ' },
  { value: 'male', label: 'Đực' },
  { value: 'female', label: 'Cái' },
];

export const ACTIVITY_OPTIONS = [
  { value: 'low', label: 'Ít vận động' },
  { value: 'medium', label: 'Vừa phải' },
  { value: 'high', label: 'Năng động' },
];

export function speciesById(petTypeId) {
  return PET_SPECIES_OPTIONS.find(item => item.pet_type_id === Number(petTypeId)) || PET_SPECIES_OPTIONS[0];
}

export function genderLabel(gender) {
  return GENDER_OPTIONS.find(item => item.value === gender)?.label || 'Chưa rõ';
}

export function activityLabel(level) {
  return ACTIVITY_OPTIONS.find(item => item.value === level)?.label || 'Vừa phải';
}

export function formatAgeMonths(ageMonths) {
  if (ageMonths === null || ageMonths === undefined || ageMonths === '') return 'Chưa cập nhật';
  const total = Number(ageMonths);
  if (!Number.isInteger(total) || total < 0) return 'Chưa cập nhật';
  if (total < 12) return `${total} tháng`;
  const years = Math.floor(total / 12);
  const months = total % 12;
  return months ? `${years} năm ${months} tháng` : `${years} tuổi (${total} tháng)`;
}

export function formatWeightKg(weightKg) {
  if (weightKg === null || weightKg === undefined || weightKg === '') return 'Chưa cập nhật';
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) return 'Chưa cập nhật';
  return `${Number.isInteger(weight) ? weight : Number(weight.toFixed(2))} kg`;
}

function validPetId(petId) {
  if (!/^[1-9]\d*$/.test(String(petId ?? ''))) {
    throw new Error('Mã thú cưng không hợp lệ.');
  }
  return Number(petId);
}

export async function listPets(token, { petTypeId, signal } = {}) {
  const query = petTypeId ? `?pet_type_id=${encodeURIComponent(String(petTypeId))}` : '';
  return commerceApi(`/api/pets${query}`, { token, signal });
}

export async function getPet(token, petId, { signal } = {}) {
  return commerceApi(`/api/pets/${validPetId(petId)}`, { token, signal });
}

export async function createPet(token, body) {
  return commerceApi('/api/pets', { method: 'POST', token, body });
}

export async function updatePet(token, petId, body) {
  return commerceApi(`/api/pets/${validPetId(petId)}`, { method: 'PUT', token, body });
}

export async function setDefaultPet(token, petId) {
  return commerceApi(`/api/pets/${validPetId(petId)}/default`, { method: 'PATCH', token });
}

export async function deletePet(token, petId) {
  return commerceApi(`/api/pets/${validPetId(petId)}`, { method: 'DELETE', token });
}

export async function getPetProducts(token, petId, { signal } = {}) {
  return commerceApi(`/api/pets/${validPetId(petId)}/products`, { token, signal });
}
