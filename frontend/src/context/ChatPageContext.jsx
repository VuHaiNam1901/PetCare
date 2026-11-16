import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { useCommerce } from './CommerceContext.jsx';
import { buildChatPageContext, customerChatRoute, sanitizeChatPageState } from '../utils/chat-page-context.js';

const Context = createContext(null);

export function ChatPageProvider({ children }) {
  const commerce = useCommerce();
  const latest = useRef(commerce);
  latest.current = commerce;
  const observation = useRef(null);
  const publish = useCallback(state => {
    const route = customerChatRoute(window.location.pathname);
    if (!route || latest.current.user?.role === 'admin') return () => {};
    const entry = { route, owner: latest.current.user?.user_id ?? null, state };
    observation.current = entry;
    return () => { if (observation.current === entry) observation.current = null; };
  }, []);
  const getContext = useCallback(() => buildChatPageContext(latest.current, observation.current, window.location.pathname), []);
  const value = useMemo(() => ({ publish, getContext }), [publish, getContext]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// Pages publish only the flags they already use to render their controls. The
// snapshot is transient and never joins the persisted conversation/session.
export function useChatPageState(state) {
  const context = useContext(Context);
  const { user } = useCommerce();
  const serialized = state ? JSON.stringify(sanitizeChatPageState(state)) : null;
  const route = window.location.pathname;
  useLayoutEffect(() => serialized ? context?.publish(JSON.parse(serialized)) : undefined, [context, serialized, route, user?.user_id, user?.role]);
}

export const useChatPageContext = () => useContext(Context)?.getContext;
