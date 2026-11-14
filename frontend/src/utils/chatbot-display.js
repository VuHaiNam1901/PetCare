import { CHAT_OPEN_KEY } from './chat-session.js';

function navigationType() {
  const timing = globalThis.performance;
  return timing?.getEntriesByType?.('navigation')?.[0]?.type ||
    (timing?.navigation?.type === 1 ? 'reload' : 'navigate');
}

// One instance per document: a React remount or a delayed session restoration
// must not repeat the reload reset after the customer has opened the panel.
export function createChatbotDisplayState({ storage = () => globalThis.sessionStorage, navigation = navigationType } = {}) {
  let initialized = false;
  const readOpen = () => {
    try { return storage()?.getItem(CHAT_OPEN_KEY) === '1'; } catch { return false; }
  };
  const writeOpen = open => {
    try { storage()?.setItem(CHAT_OPEN_KEY, open ? '1' : '0'); } catch { /* Display still works without storage. */ }
  };
  return {
    readOpen, writeOpen,
    initialOpen() {
      if (!initialized) {
        initialized = true;
        if (navigation() === 'reload') { writeOpen(false); return false; }
      }
      return readOpen();
    },
  };
}

export const chatbotDisplay = createChatbotDisplayState();
