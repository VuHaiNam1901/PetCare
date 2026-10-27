import { useEffect, useState } from 'react';
import { fetchCollection } from '../services/api.js';

export function useApiList(endpoint, collectionKey) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ data: [], loading: true, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    setState({ data: [], loading: true, error: '' });

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);

    fetchCollection(endpoint, collectionKey, controller.signal)
      .then(data => {
        if (active) setState({ data, loading: false, error: '' });
      })
      .catch(error => {
        if (!active) return;
        if (error.name === 'AbortError' && !timedOut) return;
        setState({
          data: [],
          loading: false,
          error: timedOut
            ? 'Kết nối mất nhiều thời gian hơn dự kiến. Vui lòng thử lại.'
            : error.message,
        });
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [endpoint, collectionKey, attempt]);

  return { ...state, retry: () => setAttempt(value => value + 1) };
}
