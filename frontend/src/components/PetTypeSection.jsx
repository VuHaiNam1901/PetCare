import { ErrorNotice } from './Feedback.jsx';
import '../pet-types.css';

export const PET_TYPE_LABELS = { dog: 'Chó', cat: 'Mèo', bird: 'Chim', fish: 'Cá', hamster: 'Hamster/Chuột', rabbit: 'Thỏ' };
const icons = { dog: '🐶', cat: '🐱', bird: '🐦', fish: '🐟', hamster: '🐹', rabbit: '🐰' };
const photos = {
  dog: '/images/home/pet-dog.jpg',
  cat: '/images/home/pet-cat.jpg',
};
export function PetTypeChoices({ petTypes, selected = '', onSelect, featured = false }) {
  const choices = featured ? petTypes.filter(pet => photos[pet.slug]) : petTypes;
  return <div className={`pet-type-choices${featured ? ' pet-type-choices--featured' : ''}`} style={featured ? { '--pet-type-columns': Math.min(3, choices.length) || 1 } : undefined} aria-label="Loài thú cưng">
    {onSelect && <button className={`pet-type-choice pet-type-choice-all${selected === '' ? ' is-selected' : ''}`} type="button" aria-pressed={selected === ''} onClick={() => onSelect('')}>Tất cả thú cưng</button>}
    {choices.map(pet => {
      const photo = photos[pet.slug];
      const content = featured ? (
        <>
          <span className="pet-type-card-media">
            <img src={photo} alt="" width="560" height="420" loading="lazy" />
          </span>
          <strong className="pet-type-card-title">{pet.name}</strong>
        </>
      ) : (
        <>
          {photo ? (
            <img className="pet-type-thumb" src={photo} alt="" width="28" height="28" aria-hidden="true" />
          ) : (
            <span className="pet-type-icon" aria-hidden="true">{icons[pet.slug] || '🐾'}</span>
          )}
          <span>{pet.name}</span>
        </>
      );
      return onSelect ? <button className={`pet-type-choice${featured ? ' pet-type-card' : ''}${selected === pet.slug ? ' is-selected' : ''}`} key={pet.pet_type_id} type="button" aria-pressed={selected === pet.slug} onClick={() => onSelect(pet.slug)}>{content}</button>
        : <a className={`pet-type-choice${featured ? ' pet-type-card' : ''}`} key={pet.pet_type_id} href={`/products?pet_type=${encodeURIComponent(pet.slug)}`}>{content}</a>;
    })}
  </div>;
}

export default function PetTypeSection({ petTypes, loading, error, retry }) {
  if (!loading && !error && petTypes.length === 0) return null;
  return <section className="container pet-type-section" aria-labelledby="pet-type-title">
    <div className="section-heading">
      <div>
        <span className="pet-type-eyebrow">CHỌN THEO NGƯỜI BẠN NHỎ</span>
        <h2 id="pet-type-title">Mua sắm theo thú cưng</h2>
      </div>
    </div>
    {loading ? <p className="pet-type-status" role="status">Đang tải nhóm thú cưng...</p>
      : error ? <ErrorNotice title="Chưa tải được nhóm thú cưng" message={error} onRetry={retry} />
        : <PetTypeChoices petTypes={petTypes} featured />}
  </section>;
}
