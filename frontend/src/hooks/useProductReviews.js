import { useEffect, useState } from 'react';
import { getProductReviews } from '../services/reviews.js';

export default function useProductReviews(productId, { page = 1, limit = 10, rating = '', enabled = true } = {}) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([productId, page, limit, rating, enabled, attempt]);
  const [state, setState] = useState({ key, loading: enabled, data: null, error: '', status: null });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    setState({ key, loading: true, data: null, error: '', status: null });
    getProductReviews(productId, { page, limit, rating, signal: controller.signal })
      .then(data => {
        if (active) setState({ key, loading: false, data, error: '', status: null });
      })
      .catch(error => {
        if (active) setState({ key, loading: false, data: null, error: error.message, status: error.status });
      });
    return () => { active = false; controller.abort(); };
  }, [key, productId, page, limit, rating, enabled]);

  const current = enabled && state.key === key ? state : { loading: enabled, data: null, error: '', status: null };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}
