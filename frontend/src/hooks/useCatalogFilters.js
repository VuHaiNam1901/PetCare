import { useEffect, useState } from 'react';

const defaults = { category: 'all', query: '', petType: '', sort: 'newest', page: 1 };
const sorts = ['newest', 'price-asc', 'price-desc'];

function readFilters() {
  const params = new URLSearchParams(window.location.search);
  const category = params.get('category') || params.get('category_id') || '';
  const page = params.get('page') || '1';
  return {
    category: /^[1-9]\d*$/.test(category) && Number(category) <= 2147483647 ? category : 'all',
    query: params.get('q') || '',
    petType: params.get('pet_type') || '',
    sort: sorts.includes(params.get('sort')) ? params.get('sort') : 'newest',
    page: /^[1-9]\d*$/.test(page) && Number(page) <= 2147483647 ? Number(page) : 1,
  };
}

// Keep the existing client-side catalog and load-more flow, with reloadable URLs.
export default function useCatalogFilters(listing) {
  const [filters, setFilters] = useState(() => listing ? readFilters() : defaults);
  useEffect(() => {
    if (!listing) return;
    const restore = () => setFilters(readFilters());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [listing]);
  useEffect(() => {
    if (!listing) return;
    const params = new URLSearchParams(window.location.search);
    const values = { category: filters.category === 'all' ? '' : filters.category, q: filters.query,
      pet_type: filters.petType, sort: filters.sort === 'newest' ? '' : filters.sort, page: filters.page === 1 ? '' : String(filters.page) };
    params.delete('category_id');
    for (const [name, value] of Object.entries(values)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    const target = `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`;
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', target);
  }, [filters, listing]);

  const change = patch => setFilters(previous => ({ ...previous, ...patch, page: 1 }));
  return { ...filters,
    setCategory: category => change({ category }), setQuery: query => change({ query }),
    setPetType: petType => change({ petType }), setSort: sort => change({ sort }),
    setPage: page => setFilters(previous => ({ ...previous, page })), reset: () => setFilters({ ...defaults }),
  };
}
