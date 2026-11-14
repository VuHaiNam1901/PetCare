import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send, X } from 'lucide-react';
import { TOKEN_KEY, useCommerce } from '../context/CommerceContext.jsx';
import { createChatRequestId, sendChatMessage } from '../services/chat.js';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { ProductImage } from './ProductCard.jsx';
import useChatbotDrag from '../hooks/useChatbotDrag.js';

const CONVERSATION_KEY = 'petcare.chatbot-conversation.v1';
const OPEN_KEY = 'petcare.chatbot-open.v1';
const sessionId = value => value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value));
function readConversation(identity) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONVERSATION_KEY) || 'null');
    if (saved?.version !== 1 || saved.identity !== identity || typeof saved.input !== 'string' || !sessionId(saved.session_id) || !Array.isArray(saved.turns)) return null;
    const turns = saved.turns.map(turn => {
      if (!turn?.request || typeof turn.request.message !== 'string' || !turn.request.message.trim() || [...turn.request.message].length > 2000 || typeof turn.request.request_id !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(turn.request.request_id) ||
        (turn.request.session_id !== undefined && (typeof turn.request.session_id !== 'string' || !sessionId(turn.request.session_id))) ||
        !['done', 'failed', 'sending'].includes(turn.state)) throw new Error();
      if ((turn.state === 'done' || turn.response) && (!turn.response || typeof turn.response.message !== 'string' ||
        !Array.isArray(turn.response.products) || turn.response.products.some(product => !product || !Number.isSafeInteger(product.product_id) || typeof product.name !== 'string') ||
        !Array.isArray(turn.response.warnings) || turn.response.warnings.some(warning => typeof warning !== 'string') ||
        (turn.response.follow_up != null && typeof turn.response.follow_up !== 'string'))) throw new Error();
      if (turn.state === 'failed' && (!turn.error || typeof turn.error.message !== 'string')) throw new Error();
      // A full document navigation interrupts fetch. Keep the original request
      // and UUID for the existing retry action instead of inventing a reply.
      return turn.state === 'sending' ? { ...turn, request: { ...turn.request, ...(saved.session_id ? { session_id: saved.session_id } : {}) }, state: 'failed', retryAt: 0, error: {
        message: 'Lượt trò chuyện trước chưa nhận được phản hồi khi chuyển trang. Vui lòng thử lại để tiếp tục.',
        code: 'NAVIGATION_INTERRUPTED', status: 0, retryable: true,
      } } : turn;
    });
    return { ...saved, turns };
  } catch { return null; }
}
function saveConversation(value) {
  try {
    sessionStorage.setItem(CONVERSATION_KEY, JSON.stringify({ ...value, version: 1,
      turns: value.turns.map(turn => ({ ...turn, error: turn.error ? { ...turn.error, message: turn.error.message } : null })) }));
  } catch { /* Storage limits must not interrupt the current conversation. */ }
}
function readOpen() {
  try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

function ChatbotAvatar({ size = 26 }) {
  return (
    <span className="chatbot-avatar" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path d="M32 14V7" stroke="#C6ECFF" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="6" r="4" fill="#FFD777" />
        <path d="M19 19C9 13 5 21 7 33C8 40 13 40 18 34M45 19C55 13 59 21 57 33C56 40 51 40 46 34" fill="#9DD9FF" stroke="#185C9E" strokeWidth="2.5" strokeLinejoin="round" />
        <rect x="14" y="15" width="36" height="39" rx="15" fill="#FFF9EF" stroke="#185C9E" strokeWidth="2.5" />
        <rect x="20" y="25" width="24" height="13" rx="6.5" fill="#D9F2FF" />
        <circle cx="25" cy="31" r="3" fill="#185C9E" /><circle cx="39" cy="31" r="3" fill="#185C9E" />
        <circle cx="26" cy="30" r="1" fill="white" /><circle cx="40" cy="30" r="1" fill="white" />
        <ellipse cx="32" cy="42" rx="10" ry="8" fill="#E4F2FC" />
        <path d="M29 39Q32 37 35 39Q35 42 32 43Q29 42 29 39Z" fill="#185C9E" />
        <path d="M32 43V45M26 44Q29 49 32 45Q35 49 38 44" stroke="#185C9E" strokeWidth="2" strokeLinecap="round" />
        <ellipse cx="20" cy="40" rx="3" ry="2" fill="#FFB7B3" /><ellipse cx="44" cy="40" rx="3" ry="2" fill="#FFB7B3" />
      </svg>
    </span>
  );
}

function ChatProducts({ products }) {
  return products.length > 0 && (
    <div className="chatbot-products" aria-label="Sản phẩm được gợi ý">
      {products.map(product => (
        <article className="chatbot-product-card" key={product.product_id}>
          <a href={`/products/${product.product_id}`}>
            <div className="chatbot-product-image"><ProductImage source={resolveImageUrl(product.image_url)} name={product.name} width={56} height={56} /></div>
            <div><strong>{product.name}</strong><span className="chatbot-product-price">{formatPrice(product.price)}</span><span>{product.available ? 'Còn hàng' : 'Tạm hết hàng'}</span></div>
          </a>
        </article>
      ))}
    </div>
  );
}

// Closing keeps this session mounted. Both memory and saved conversation data
// remain bound to the current identity; changing owners aborts old requests.
function ChatSession({ open, closeChat, token, disabledReason, inputRef, panelRef, identity }) {
  const [restored] = useState(() => readConversation(identity));
  const [input, setInput] = useState(restored?.input || '');
  const [turns, setTurns] = useState(restored?.turns || []);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [now, setNow] = useState(Date.now);
  const conversationRef = useRef(null);
  const errorRef = useRef(null);
  const sessionRef = useRef(restored?.session_id || null);
  const inFlight = useRef(false);
  const activeRequest = useRef(null);
  const alive = useRef(false);
  const lastTurn = turns.at(-1);
  const failed = lastTurn?.state === 'failed' ? lastTurn : null;
  const retryAt = failed?.retryAt || 0;
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const blocked = Boolean(disabledReason || sending || failed);

  const snapshot = useRef(null);
  snapshot.current = { identity, input, turns, session_id: sessionRef.current };
  useEffect(() => { saveConversation(snapshot.current); }, [input, turns, identity]);
  useEffect(() => {
    const persist = () => saveConversation({ ...snapshot.current, session_id: sessionRef.current });
    window.addEventListener('pagehide', persist);
    return () => { window.removeEventListener('pagehide', persist); persist(); };
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (open && !blocked) inputRef.current?.focus();
  }, [open, blocked, inputRef]);

  useEffect(() => {
    if (open && failed) errorRef.current?.focus();
  }, [open, failed]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (open && conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [turns, open, sending]);

  useEffect(() => {
    if (!retryAt) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [retryAt]);

  async function sendTurn(turn, retry = false) {
    // The ref closes the double-click/Enter race before React renders loading.
    if (inFlight.current || disabledReason) return;
    inFlight.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    setSending(true);
    setFormError('');
    setTurns(previous => retry
      ? previous.map(item => item.request.request_id === turn.request.request_id ? { ...turn, state: 'sending', error: null } : item)
      : [...previous, turn]);
    try {
      const response = await sendChatMessage(turn.request, { token, signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      sessionRef.current = response.session_id;
      setTurns(previous => previous.map(item => item.request.request_id === turn.request.request_id
        ? { ...item, state: 'done', response, error: null } : item));
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      // Retryable errors can issue a session even when generation/save failed.
      // Never replace this turn's UUID or text when adopting that capability.
      if (error.session_id) sessionRef.current = error.session_id;
      const request = { ...turn.request, ...(sessionRef.current ? { session_id: sessionRef.current } : {}) };
      const retryAt = Date.now() + (error.retryAfterMs || 0);
      setNow(Date.now());
      setTurns(previous => previous.map(item => item.request.request_id === request.request_id
        ? { ...item, request, state: 'failed', error, retryAt } : item));
    } finally {
      if (activeRequest.current === controller) {
        inFlight.current = false;
        activeRequest.current = null;
        if (alive.current) setSending(false);
      }
    }
  }

  function submit(event) {
    event.preventDefault();
    if (blocked || inFlight.current) return;
    const message = input.trim();
    if (!message) return;
    if ([...message].length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)) {
      setFormError('Vui lòng nhập từ 1–2000 ký tự và không dùng ký tự điều khiển.');
      return;
    }
    try {
      const request = { message, request_id: createChatRequestId(), ...(sessionRef.current ? { session_id: sessionRef.current } : {}) };
      setInput('');
      void sendTurn({ request, state: 'sending' });
    } catch {
      setFormError('Chưa thể gửi tin nhắn an toàn trong trình duyệt này. Vui lòng tải lại trang.');
    }
  }

  function newConversation() {
    if (inFlight.current) return;
    sessionRef.current = null;
    setTurns([]);
    setInput('');
    setFormError('');
    inputRef.current?.focus();
  }

  if (!open) return null;
  return createPortal(
    <section ref={panelRef} className="chatbot-panel" id="petcare-chatbot" role="dialog" aria-modal="false" aria-labelledby="chatbot-title">
      <div className="chatbot-header">
        <ChatbotAvatar />
        <h2 id="chatbot-title">Trợ lý PetCareShop</h2>
        <button className="chatbot-close icon-button" type="button" aria-label="Đóng Trợ lý PetCareShop" onClick={closeChat}><X size={21} aria-hidden="true" /></button>
      </div>
      {turns.length > 0 && <div className="chatbot-toolbar"><button type="button" onClick={newConversation} disabled={sending}>Cuộc trò chuyện mới</button></div>}
      <div className="chatbot-conversation" ref={conversationRef} role="log" aria-label="Hội thoại Trợ lý PetCareShop" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {turns.length === 0 ? (
          <div className="chatbot-empty" aria-hidden="true"><ChatbotAvatar size={22} /></div>
        ) : turns.map(turn => (
          <Fragment key={turn.request.request_id}>
            <div className="chatbot-user"><p>{turn.request.message}</p><span className="chatbot-message-label">{turn.state === 'sending' ? 'Đang gửi' : turn.state === 'failed' ? 'Chưa nhận được phản hồi' : 'Bạn'}</span></div>
            {turn.response && <div className="chatbot-assistant">
              <span className="chatbot-message-label">Trợ lý PetCareShop</span>
              <p>{turn.response.message}</p>
              <ChatProducts products={turn.response.products} />
              {turn.response.follow_up && <p className="chatbot-follow-up">{turn.response.follow_up}</p>}
              {turn.response.warnings.length > 0 && <ul className="chatbot-warnings" aria-label="Lưu ý">{turn.response.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            </div>}
            {turn.state === 'failed' && <div className="chatbot-error" role="alert" tabIndex={-1} ref={errorRef}>
              <p>{turn.error.message}</p>
              {turn.error.retryable && !turn.request.session_id && <p>Chưa nhận được phiên trò chuyện. Thử lại có thể bắt đầu một cuộc trò chuyện mới.</p>}
              {turn.error.retryable ? <>
                {retrySeconds > 0 && <p>Có thể thử lại sau {retrySeconds} giây.</p>}
                <button type="button" disabled={sending || retrySeconds > 0} onClick={() => { if (Date.now() >= turn.retryAt) void sendTurn(turn, true); }}>Thử lại</button>
              </> : <p>{[401, 403].includes(turn.error.status) && turn.error.code !== 'SESSION_FORBIDDEN'
                ? <a href="/login?returnTo=%2F">Đăng nhập lại để tiếp tục</a>
                : 'Hãy bắt đầu cuộc trò chuyện mới để tiếp tục.'}</p>}
            </div>}
          </Fragment>
        ))}
      </div>
      <p className="chatbot-status" role="status">{disabledReason || (sending ? 'Trợ lý đang trả lời…' : failed ? (failed.error.retryable ? 'Bạn có thể thử lại hoặc bắt đầu cuộc trò chuyện mới.' : 'Chưa thể tiếp tục lượt trò chuyện này.') : lastTurn?.state === 'done' ? 'Đã nhận phản hồi từ trợ lý.' : '')}</p>
      {formError && <p className="chatbot-form-error" role="alert">{formError}</p>}
      <form className="chatbot-composer" onSubmit={submit}>
        <input ref={inputRef} type="text" aria-label="Nội dung tin nhắn" placeholder="Nhập nội dung..." maxLength={2000} value={input} onChange={event => setInput(event.target.value)} autoComplete="off" disabled={blocked} />
        <button type="submit" aria-label="Gửi tin nhắn" title="Gửi tin nhắn" disabled={blocked || !input.trim()}><Send size={19} aria-hidden="true" /></button>
      </form>
    </section>, document.body
  );
}

export default function ChatbotWidget() {
  const { user, authLoading } = useCommerce();
  const [open, setOpen] = useState(readOpen);
  const [restoration, setRestoration] = useState(0);
  const openerRef = useRef(null);
  const inputRef = useRef(null);
  let token = null;
  let storageAvailable = true;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { storageAvailable = false; }
  const disabledReason = authLoading ? 'Đang kiểm tra phiên đăng nhập…'
    : !storageAvailable ? 'Vui lòng cho phép trình duyệt truy cập phiên đăng nhập để sử dụng chatbot.'
      : user && user.role !== 'user' ? 'Chatbot dành cho khách và tài khoản khách hàng.'
        : Boolean(user) !== Boolean(token) ? 'Chưa xác nhận được phiên đăng nhập. Vui lòng đăng nhập lại.' : '';
  // Token rotation and guest/account transitions cannot reuse capabilities or
  // render messages belonging to an earlier authenticated identity.
  const identity = `${authLoading ? 'loading' : user ? `user:${user.user_id}:${user.role}:${user.status || ''}` : 'guest'}:${storageAvailable}:${token || ''}`;
  const { widgetRef, panelRef, dragging, consumeDragClick, dragEvents } = useChatbotDrag(open, `${identity}:${restoration}`);

  const changeOpen = value => {
    setOpen(value);
    try { sessionStorage.setItem(OPEN_KEY, value ? '1' : '0'); } catch { /* The panel remains usable without storage. */ }
  };

  const closeChat = () => {
    changeOpen(false);
    openerRef.current?.focus();
  };

  useEffect(() => {
    const restore = event => {
      if (!event.persisted) return;
      setOpen(readOpen());
      setRestoration(value => value + 1);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const handleEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        changeOpen(false);
        openerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  return (
    <div ref={widgetRef} className={`chatbot-widget${dragging ? ' is-dragging' : ''}`}>
      {!authLoading && <ChatSession key={`${identity}:${restoration}`} identity={identity} open={open} closeChat={closeChat} token={user ? token : null} disabledReason={disabledReason} inputRef={inputRef} panelRef={panelRef} />}
      <button ref={openerRef} className="chatbot-toggle" type="button" aria-label={open ? 'Thu gọn Trợ lý PetCareShop' : 'Mở Trợ lý PetCareShop'} title="Trợ lý PetCareShop — kéo để di chuyển" aria-expanded={open} aria-controls="petcare-chatbot" {...dragEvents} onClick={event => { if (!consumeDragClick(event)) open ? closeChat() : changeOpen(true); }}>
        <ChatbotAvatar size={42} /><span className="sr-only">Trợ lý PetCareShop</span>
      </button>
    </div>
  );
}
