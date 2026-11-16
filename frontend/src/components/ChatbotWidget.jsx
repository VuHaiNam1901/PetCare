import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send, X } from 'lucide-react';
import { TOKEN_KEY, useCommerce } from '../context/CommerceContext.jsx';
import { createChatRequestId, sendChatMessageWithRecovery } from '../services/chat.js';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { ProductImage } from './ProductCard.jsx';
import useChatbotDrag from '../hooks/useChatbotDrag.js';
import { CHAT_AUTH_EVENT, chatIdentity, restoreChatConversation, saveChatConversation } from '../utils/chat-session.js';
import { chatbotDisplay } from '../utils/chatbot-display.js';
import { useChatPageContext } from '../context/ChatPageContext.jsx';
import chatbotPawIcon from '../assets/chatbot-paw.png';

function ChatbotIcon({ size = 32, className = '' }) {
  return <img className={`chatbot-icon ${className}`} src={chatbotPawIcon} alt="" aria-hidden="true" width={size} height={size} draggable={false} />;
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
function ChatSession({ open, closeChat, token, disabledReason, inputRef, panelRef, identity, initialConversation, revision = null, restoreError, onRestoreRetry }) {
  const getPageContext = useChatPageContext();
  const [restored] = useState(initialConversation);
  const [input, setInput] = useState(restored?.input || '');
  const [turns, setTurns] = useState(restored?.turns || []);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [cooldownUntil, setCooldownUntil] = useState(() => Number.isSafeInteger(restored?.cooldownUntil) ? restored.cooldownUntil : 0);
  const conversationRef = useRef(null);
  const errorRef = useRef(null);
  const sessionRef = useRef(restored?.session_id || null);
  const inFlight = useRef(false);
  const activeRequest = useRef(null);
  const alive = useRef(false);
  const completedRequests = useRef(new Set((restored?.turns || []).filter(turn => turn.state === 'done').map(turn => turn.request.request_id)));
  const lastTurn = turns.at(-1);
  const failed = lastTurn?.state === 'failed' ? lastTurn : null;
  const retryAt = Math.max(cooldownUntil, restoreError?.retryAt || 0, ...turns.filter(turn => turn.state === 'failed').map(turn => turn.retryAt || 0));
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const blocked = Boolean(disabledReason || sending || restoreError);

  const snapshot = useRef(null);
  snapshot.current = { identity, input, turns, cooldownUntil, session_id: sessionRef.current };
  useEffect(() => { saveChatConversation(snapshot.current, revision); }, [input, turns, identity, cooldownUntil, revision]);
  useEffect(() => {
    const persist = () => saveChatConversation({ ...snapshot.current, session_id: sessionRef.current }, revision);
    window.addEventListener('pagehide', persist);
    return () => { window.removeEventListener('pagehide', persist); persist(); };
  }, [revision]);

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
    if (retryAt <= Date.now()) return;
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
    if (inFlight.current || disabledReason || Date.now() < cooldownUntil || completedRequests.current.has(turn.request.request_id) ||
        (retry && Date.now() < (turn.retryAt || 0))) return;
    inFlight.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    setSending(true);
    setFormError('');
    setTurns(previous => retry
      ? previous.map(item => item.request.request_id === turn.request.request_id ? { ...turn, state: 'sending', error: null } : item)
      : [...previous, turn]);
    try {
      const request = { ...turn.request, ...(!turn.request.session_id && sessionRef.current ? { session_id: sessionRef.current } : {}),
        ...(getPageContext ? { page_context: getPageContext() } : {}) };
      const response = await sendChatMessageWithRecovery(request, { token, signal: controller.signal,
        onSession(session) {
          if (!alive.current || controller.signal.aborted) return;
          sessionRef.current = session;
          snapshot.current = { ...snapshot.current, session_id: session };
          setTurns(previous => previous.map(item => item.request.request_id === request.request_id
            ? { ...item, request: { ...item.request, session_id: session } } : item));
        },
      });
      if (!alive.current || controller.signal.aborted) return;
      sessionRef.current = response.session_id;
      completedRequests.current.add(turn.request.request_id);
      setTurns(previous => previous.map(item => item.request.request_id === turn.request.request_id
        ? { ...item, state: 'done', response, error: null } : item));
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      // Retryable errors can issue a session even when generation/save failed.
      // Never replace this turn's UUID or text when adopting that capability.
      if (error.session_id) sessionRef.current = error.session_id;
      if (error.code === 'SESSION_FORBIDDEN') sessionRef.current = null;
      const request = { ...turn.request, ...(sessionRef.current ? { session_id: sessionRef.current } : {}) };
      const retryAt = Date.now() + (error.retryAfterMs || 0);
      setNow(Date.now());
      if (error.kind === 'quota' || error.code === 'GEMINI_QUOTA' || error.code === 'RATE_LIMITED') {
        setCooldownUntil(previous => Math.max(previous, retryAt));
      }
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
    if (blocked || inFlight.current || Date.now() < cooldownUntil) return;
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
    completedRequests.current.clear();
    setTurns([]);
    setInput('');
    setFormError('');
    inputRef.current?.focus();
  }

  if (!open) return null;
  return createPortal(
    <section ref={panelRef} className="chatbot-panel" id="petcare-chatbot" role="dialog" aria-modal="false" aria-labelledby="chatbot-title">
      <div className="chatbot-header">
        <ChatbotIcon />
        <h2 id="chatbot-title">Trợ lý PetCareShop</h2>
        <button className="chatbot-close icon-button" type="button" aria-label="Đóng Trợ lý PetCareShop" onClick={closeChat}><X size={21} aria-hidden="true" /></button>
      </div>
      {turns.length > 0 && <div className="chatbot-toolbar"><button type="button" onClick={newConversation} disabled={sending}>Cuộc trò chuyện mới</button></div>}
      {restoreError && <div className="chatbot-error" role="alert"><p>{restoreError.message}</p><button type="button" disabled={now < restoreError.retryAt} onClick={onRestoreRetry}>Thử lại</button></div>}
      <div className="chatbot-conversation" ref={conversationRef} role="log" aria-label="Hội thoại Trợ lý PetCareShop" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {turns.length === 0 ? (
          <div className="chatbot-empty" aria-hidden="true"><ChatbotIcon size={44} /></div>
        ) : turns.map(turn => {
          const retrySeconds = Math.max(0, Math.ceil((Math.max(turn.retryAt || 0, cooldownUntil) - now) / 1000));
          return (
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
              {turn.error.retryable ? <>
                {retrySeconds > 0 && <p>Có thể thử lại sau {retrySeconds} giây.</p>}
                <button type="button" disabled={sending || retrySeconds > 0} onClick={() => { if (Date.now() >= turn.retryAt) void sendTurn(turn, true); }}>Thử lại</button>
              </> : <p>{[401, 403].includes(turn.error.status) && turn.error.code !== 'SESSION_FORBIDDEN'
                ? <a href="/login?returnTo=%2F">Đăng nhập lại để tiếp tục</a>
                : 'Nội dung hội thoại vẫn được giữ. Bạn có thể tiếp tục gửi tin nhắn khác.'}</p>}
            </div>}
          </Fragment>
        ); })}
      </div>
      <p className="chatbot-status" role="status">{disabledReason || (sending ? 'Trợ lý đang trả lời…' : cooldownSeconds > 0 ? `Dịch vụ đang giới hạn lượt tư vấn. Có thể thử lại sau ${cooldownSeconds} giây.` : failed ? 'Hội thoại vẫn được giữ. Bạn có thể thử lại hoặc gửi tin nhắn khác.' : lastTurn?.state === 'done' ? 'Đã nhận phản hồi từ trợ lý.' : '')}</p>
      {formError && <p className="chatbot-form-error" role="alert">{formError}</p>}
      <form className="chatbot-composer" onSubmit={submit}>
        <input ref={inputRef} type="text" aria-label="Nội dung tin nhắn" placeholder="Nhập nội dung..." maxLength={2000} value={input} onChange={event => setInput(event.target.value)} autoComplete="off" disabled={blocked} />
        <button type="submit" aria-label="Gửi tin nhắn" title="Gửi tin nhắn" disabled={blocked || cooldownSeconds > 0 || !input.trim()}><Send size={19} aria-hidden="true" /></button>
      </form>
    </section>, document.body
  );
}

export default function ChatbotWidget() {
  const { user, authLoading } = useCommerce();
  const [open, setOpen] = useState(chatbotDisplay.initialOpen);
  const [restoration, setRestoration] = useState(0);
  const [loaded, setLoaded] = useState(null);
  const openerRef = useRef(null);
  const inputRef = useRef(null);
  let token = null;
  let storageAvailable = true;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { storageAvailable = false; }
  const disabledReason = authLoading ? 'Đang kiểm tra phiên đăng nhập…'
    : !storageAvailable ? 'Vui lòng cho phép trình duyệt truy cập phiên đăng nhập để sử dụng chatbot.'
      : user && user.role !== 'user' ? 'Chatbot dành cho khách và tài khoản khách hàng.'
        : Boolean(user) !== Boolean(token) ? 'Chưa xác nhận được phiên đăng nhập. Vui lòng đăng nhập lại.' : '';
  const identity = chatIdentity(user);
  const sessionKey = `${identity}:${token || ''}:${restoration}`;
  const ready = !disabledReason && loaded?.key === sessionKey && loaded.status === 'ready';
  const recoveryError = loaded?.key === sessionKey && loaded.status === 'error' ? loaded.error : null;
  const { widgetRef, panelRef, dragging, consumeDragClick, dragEvents } = useChatbotDrag(open, sessionKey);

  useEffect(() => {
    if (disabledReason) { setLoaded(null); return; }
    const controller = new AbortController();
    setLoaded({ key: sessionKey, status: 'loading' });
    restoreChatConversation(identity, { token: user ? token : null, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) {
        setLoaded({ key: sessionKey, status: 'ready', ...result });
      }
    }).catch(error => {
      if (!controller.signal.aborted) setLoaded({ key: sessionKey, status: 'error',
        error: { message: error.message, retryAt: Date.now() + (error.retryAfterMs || 0) } });
    });
    return () => controller.abort();
  }, [sessionKey, identity, token, disabledReason]);

  useEffect(() => {
    const reset = () => { setOpen(false); setLoaded(null); setRestoration(value => value + 1); };
    window.addEventListener(CHAT_AUTH_EVENT, reset);
    return () => window.removeEventListener(CHAT_AUTH_EVENT, reset);
  }, []);

  const changeOpen = value => {
    setOpen(value);
    chatbotDisplay.writeOpen(value);
  };

  const closeChat = () => {
    changeOpen(false);
    openerRef.current?.focus();
  };

  useEffect(() => {
    const restore = event => {
      if (!event.persisted) return;
      setOpen(chatbotDisplay.readOpen());
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
      {!authLoading && <ChatSession key={`${sessionKey}:${ready ? 'ready' : 'pending'}`} identity={identity} open={open} closeChat={closeChat} token={user ? token : null}
        disabledReason={disabledReason || (!ready && !recoveryError ? 'Đang khôi phục phiên trò chuyện…' : '')}
        initialConversation={ready ? loaded.conversation : null} revision={ready ? loaded.revision : null}
        restoreError={recoveryError} onRestoreRetry={() => setRestoration(value => value + 1)} inputRef={inputRef} panelRef={panelRef} />}
      <button ref={openerRef} className="chatbot-toggle" type="button" aria-label={open ? 'Thu gọn Trợ lý PetCareShop' : 'Mở Trợ lý PetCareShop'} title="Trợ lý PetCareShop — kéo để di chuyển" aria-expanded={open} aria-controls="petcare-chatbot" {...dragEvents} onClick={event => { if (!consumeDragClick(event)) open ? closeChat() : changeOpen(true); }}>
        <ChatbotIcon size={60} className="chatbot-toggle-image" /><span className="sr-only">Trợ lý PetCareShop</span>
      </button>
    </div>
  );
}
