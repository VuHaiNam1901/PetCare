import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getVoucherReadiness } from '../services/vouchers.js';

const Context = createContext(null);
const pending = { ready: false, onlineReady: false, loading: true, error: '' };
export function VoucherReadinessProvider({ children }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState(pending);
  const retry = useCallback(() => { setState(pending); setRevision(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    getVoucherReadiness({ signal: controller.signal }).then(result => {
      if (active) setState({ ready: result.ready, onlineReady: result.online_ready, loading: false, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted) setState({ ready: false, onlineReady: false, loading: false, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  const value = useMemo(() => ({ ...state, retry }), [state, retry]);
  return createElement(Context.Provider, { value }, children);
}
export function useVoucherReadiness() {
  const value = useContext(Context);
  if (!value) throw new Error('VoucherReadinessProvider is required');
  return value;
}
