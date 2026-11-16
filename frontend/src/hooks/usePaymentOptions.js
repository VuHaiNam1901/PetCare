import { useCallback, useEffect, useState } from 'react';
import { getPaymentOptions } from '../services/payments.js';

const pending = { available: false, mode: null, loading: true, error: '' };
export default function usePaymentOptions() {
  const [state, setState] = useState(pending);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => { setState(pending); setRevision(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    getPaymentOptions({ signal: controller.signal }).then(options => {
      if (!controller.signal.aborted) setState({ available: options.online_available, mode: options.online_mode, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ available: false, mode: null, loading: false, error: error.message });
    });
    return () => controller.abort();
  }, [revision]);
  return { ...state, retry };
}
