import { claimGuestChatSession, loadChatConversation } from '../services/chat.js';

const PREFIX = 'petcare.chatbot-conversation.v2.';
const LEGACY = 'petcare.chatbot-conversation.v1';
const ACTIVE = 'petcare.chatbot-owner.v2';
export const CHAT_OPEN_KEY = 'petcare.chatbot-open.v1';
export const CHAT_AUTH_EVENT = 'petcare:chat-auth-change';
const ownerValid = owner => owner === 'guest' || /^user:[1-9]\d*$/.test(owner);
const validSession = value => value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value));
const read = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
const write = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const remove = key => { try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } };
const epochKey = owner => `petcare.chatbot-revision.v2.${owner}`;
export const chatIdentity = user => user ? (user.role === 'user' ? `user:${user.user_id}` : 'blocked') : 'guest';
export const chatRevision = owner => read(epochKey(owner)) || 0;
const revoke = owner => write(epochKey(owner), chatRevision(owner) + 1);
const current = (owner, revision) => read(ACTIVE) === owner && chatRevision(owner) === revision;

function snapshot(saved, identity) {
  if (!saved || typeof saved.input !== 'string' || !validSession(saved.session_id) || !Array.isArray(saved.turns)) return null;
  try {
    const turns = saved.turns.map(turn => {
      if (!turn?.request || typeof turn.request.message !== 'string' || !turn.request.message.trim() || [...turn.request.message].length > 2000 ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(turn.request.request_id) ||
          (turn.request.session_id !== undefined && (typeof turn.request.session_id !== 'string' || !validSession(turn.request.session_id))) || !['done', 'failed', 'sending'].includes(turn.state)) throw new Error();
      if ((turn.state === 'done' || turn.response) && (!turn.response || typeof turn.response.message !== 'string' || !Array.isArray(turn.response.products) ||
          turn.response.products.some(product => !product || !Number.isSafeInteger(product.product_id) || typeof product.name !== 'string') ||
          !Array.isArray(turn.response.warnings) || turn.response.warnings.some(warning => typeof warning !== 'string') ||
          (turn.response.follow_up != null && typeof turn.response.follow_up !== 'string'))) throw new Error();
      if (turn.state === 'failed' && (!turn.error || typeof turn.error.message !== 'string')) throw new Error();
      return turn.state !== 'sending' ? turn : { ...turn, state: 'failed', retryAt: 0,
        request: { ...turn.request, ...(saved.session_id ? { session_id: saved.session_id } : {}) },
        error: { code: 'NAVIGATION_INTERRUPTED', status: 0, retryable: true,
          message: 'Lượt trò chuyện trước bị gián đoạn khi chuyển trang. Bạn có thể nhấn Thử lại để tiếp tục.' } };
    });
    return { version: 2, identity, input: saved.input, session_id: saved.session_id, turns,
      cooldownUntil: Number.isSafeInteger(saved.cooldownUntil) ? saved.cooldownUntil : 0 };
  } catch { return null; }
}

export function readChatConversation(identity) {
  if (!ownerValid(identity)) return null;
  const saved = read(PREFIX + identity);
  if (saved?.version === 2 && saved.identity === identity) return snapshot(saved, identity);
  const old = read(LEGACY);
  const matching = identity === 'guest' ? old?.identity === 'guest:true:' : old?.identity?.startsWith(`${identity}:user:`);
  if (old?.version === 1 && matching) {
    const migrated = snapshot(old, identity);
    if (migrated && write(PREFIX + identity, migrated)) remove(LEGACY);
    return migrated;
  }
  return null;
}

export function saveChatConversation(value, revision) {
  if (revision == null || !ownerValid(value.identity) || !current(value.identity, revision)) return false;
  return write(PREFIX + value.identity, { ...value, version: 2,
    turns: value.turns.map(turn => ({ ...turn, error: turn.error ? { ...turn.error, message: turn.error.message } : null })) });
}

export function activateChatIdentity(identity) {
  if (!ownerValid(identity)) { clearChatOnLogout(); return; }
  const legacy = read(LEGACY);
  if (legacy?.identity?.startsWith('user:') && !legacy.identity.startsWith(`${identity}:user:`)) remove(LEGACY);
  const previous = read(ACTIVE);
  if (previous && previous !== identity && previous !== 'guest') {
    revoke(previous);
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index--) {
        const key = sessionStorage.key(index);
        if (key === PREFIX + previous || key?.startsWith(`${PREFIX}${previous}:`)) remove(key);
      }
      sessionStorage.setItem(CHAT_OPEN_KEY, '0');
    } catch { /* Authentication must remain usable without storage. */ }
  }
  write(ACTIVE, identity);
}

export function clearChatOnLogout() {
  const active = read(ACTIVE);
  if (ownerValid(active)) revoke(active);
  revoke('guest');
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) remove(key);
    }
    sessionStorage.setItem(CHAT_OPEN_KEY, '0');
  } catch { /* Never prevent logout. */ }
  remove(LEGACY);
  write(ACTIVE, 'guest');
  try { window.dispatchEvent(new Event(CHAT_AUTH_EVENT)); } catch { /* No active widget. */ }
}

async function finishClaim(identity, token, revision, signal) {
  const pending = read(`${PREFIX}${identity}:pending`);
  if (!pending || pending.identity !== identity) return;
  const session = await claimGuestChatSession(pending.session_id, { token, signal });
  if (!current(identity, revision) || signal?.aborted) return;
  const previous = readChatConversation(identity);
  if (previous?.session_id && previous.session_id !== session) write(`${PREFIX}${identity}:archive:${previous.session_id}`, previous);
  const claimed = { ...pending, identity, session_id: session,
    turns: pending.turns.map(turn => ({ ...turn, request: { ...turn.request, session_id: session },
      ...(turn.response ? { response: { ...turn.response, session_id: session } } : {}) })) };
  saveChatConversation(claimed, revision);
  remove(`${PREFIX}${identity}:pending`);
}

// Called only after a successful explicit login, never during auth bootstrap.
export async function completeChatLogin(user, token) {
  const identity = chatIdentity(user);
  const guest = read(ACTIVE) === 'guest' || read(ACTIVE) === null ? readChatConversation('guest') : null;
  if (!ownerValid(identity)) { clearChatOnLogout(); return; }
  activateChatIdentity(identity);
  if (!guest || (!guest.turns.length && !guest.input.trim())) return;
  if (!guest.session_id) {
    const previous = readChatConversation(identity);
    if (previous?.session_id) write(`${PREFIX}${identity}:archive:${previous.session_id}`, previous);
    saveChatConversation({ ...guest, identity }, chatRevision(identity));
    revoke('guest'); remove(PREFIX + 'guest'); remove(LEGACY);
    return;
  }
  const pending = { ...guest, identity };
  // Remove the public cache before auth completes. A delayed guest unmount
  // cannot recreate it, and a failed claim remains private to this user.
  if (!write(`${PREFIX}${identity}:pending`, pending)) return;
  revoke('guest'); remove(PREFIX + 'guest'); remove(LEGACY);
  const revision = chatRevision(identity);
  try { await finishClaim(identity, token, revision); }
  catch { /* Retain the pending capability; restoration can safely retry. */ }
}

export async function restoreChatConversation(identity, { token, signal } = {}) {
  activateChatIdentity(identity);
  const revision = chatRevision(identity);
  if (identity !== 'guest') {
    try { await finishClaim(identity, token, revision, signal); }
    catch (error) {
      if (error.code === 'SESSION_FORBIDDEN' && current(identity, revision)) remove(`${PREFIX}${identity}:pending`);
      else throw error;
    }
  }
  try {
    const saved = readChatConversation(identity);
    if (!saved?.session_id) return { conversation: saved, revision };
    const committed = await loadChatConversation(saved.session_id, { token, signal });
    if (!current(identity, revision) || signal?.aborted) throw Object.assign(new Error('Yêu cầu khôi phục đã được hủy.'), { name: 'AbortError', code: 'REQUEST_ABORTED' });
    const known = new Set(committed.map(turn => turn.request.request_id));
    const unique = new Map(saved.turns.map(turn => [turn.request.request_id, turn]));
    // MySQL provides the latest committed window in order. Keep older local
    // turns and unsaved requests/drafts, replacing recovered UUIDs exactly once.
    const remaining = [...unique.values()].filter(turn => !known.has(turn.request.request_id));
    const conversation = { ...saved, turns: [...remaining.filter(turn => turn.state === 'done'),
      ...committed, ...remaining.filter(turn => turn.state !== 'done')] };
    saveChatConversation(conversation, revision);
    return { conversation, revision };
  } catch (error) {
    if (error.code === 'SESSION_FORBIDDEN' && current(identity, revision)) {
      // Denied content must never be rendered. Server history is untouched.
      remove(PREFIX + identity); remove(`${PREFIX}${identity}:pending`); revoke(identity);
      return { conversation: null, revision: chatRevision(identity) };
    }
    throw error;
  }
}
