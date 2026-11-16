import { ErrorNotice } from './Feedback.jsx';
import '../pet-types.css';

export const PET_TYPE_LABELS = { dog: 'Chó', cat: 'Mèo', bird: 'Chim', fish: 'Cá', hamster: 'Hamster', rabbit: 'Thỏ' };
const icons = { dog: '🐶', cat: '🐱', bird: '🐦', fish: '🐟', hamster: '🐹', rabbit: '🐰' };
const photos = {
  dog: '/images/home/pet-dog.jpg',
  cat: '/images/home/pet-cat.jpg',
  bird: '/images/home/pet-bird.jpg',
  fish: '/images/home/pet-fish.jpg',
  hamster: '/images/home/pet-hamster.jpg',
  rabbit: '/images/home/pet-rabbit.jpg',
};
const photoFrames = {
  bird: { '--pet-photo-position': 'center', '--pet-photo-scale': 2.2, '--pet-photo-origin': '46% 18%' },
  fish: { '--pet-photo-position': 'center 90%' },
  hamster: { '--pet-photo-position': 'center 42%' },
  rabbit: { '--pet-photo-position': 'center 26%' },
};
export function PetTypeChoices({ petTypes, selected = '', onSelect, featured = false }) {
  return <div className={`pet-type-choices${featured ? ' pet-type-choices--featured' : ''}`} aria-label="Loài thú cưng">
    {onSelect && <button className={`pet-type-choice pet-type-choice-all${selected === '' ? ' is-selected' : ''}`} type="button" aria-pressed={selected === ''} onClick={() => onSelect('')}>Tất cả thú cưng</button>}
    {petTypes.map(pet => {
      const photo = photos[pet.slug];
      const name = Object.hasOwn(PET_TYPE_LABELS, pet.slug) ? PET_TYPE_LABELS[pet.slug] : pet.name;
      const content = featured ? (
        <>
          <span className="pet-type-card-media" style={photoFrames[pet.slug]}>
            <img src={photo} alt="" width="560" height="420" loading="lazy" />
          </span>
          <strong className="pet-type-card-title">{name}</strong>
        </>
      ) : (
        <>
          {photo ? (
            <img className="pet-type-thumb" src={photo} alt="" width="28" height="28" aria-hidden="true" />
          ) : (
            <span className="pet-type-icon" aria-hidden="true">{icons[pet.slug] || '🐾'}</span>
          )}
          <span>{name}</span>
        </>
      );
      return onSelect ? <button className={`pet-type-choice${featured ? ' pet-type-card' : ''}${selected === pet.slug ? ' is-selected' : ''}`} key={pet.pet_type_id} type="button" aria-pressed={selected === pet.slug} onClick={() => onSelect(pet.slug)}>{content}</button>
        : <a className={`pet-type-choice${featured ? ' pet-type-card' : ''}`} key={pet.pet_type_id} href={`/products?pet_type=${encodeURIComponent(pet.slug)}`}>{content}</a>;
    })}
  </div>;
}

export function PetTypePhotoCredits() {
  return <details className="pet-type-photo-credits">
    <summary>Nguồn ảnh</summary>
    <ul>
      <li>Chim: <a href="https://www.pexels.com/photo/green-bird-on-brown-tree-branch-4084648/" target="_blank" rel="noreferrer">omer havivi</a> — <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">Pexels License</a>.</li>
      <li>Cá: <a href="https://www.pexels.com/photo/goldfish-swimming-in-pure-water-of-aquarium-7188160/" target="_blank" rel="noreferrer">Nothing Ahead</a> — <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">Pexels License</a>.</li>
      <li>Hamster: “Goldhamster 2”, Mandy (Amanda77), qua <a href="https://commons.wikimedia.org/wiki/File:Goldhamster_2.jpg" target="_blank" rel="noreferrer">Wikimedia Commons</a> — <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer license">CC BY-SA 3.0</a>. Ảnh gốc được giữ nguyên; khung hiển thị được căn bằng CSS.</li>
      <li>Thỏ: <a href="https://pixabay.com/photos/cute-baby-bunny-rabbit-pet-easter-2500929/" target="_blank" rel="noreferrer">strengthinnumbers</a> — <a href="https://pixabay.com/service/license-summary/" target="_blank" rel="noreferrer">Pixabay Content License</a>.</li>
    </ul>
  </details>;
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
        : <>
          <PetTypeChoices petTypes={petTypes} featured />
          <PetTypePhotoCredits />
        </>}
  </section>;
}
