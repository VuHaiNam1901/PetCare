import { Fragment, useEffect, useRef, useState } from 'react';
import { Bot, Send, X } from 'lucide-react';
import { TOKEN_KEY, useCommerce } from '../context/CommerceContext.jsx';
import { createChatRequestId, sendChatMessage } from '../services/chat.js';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { ProductImage } from './ProductCard.jsx';

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

// This component stays mounted when the panel is closed. Changing its identity
// key discards the entire conversation and aborts requests from the old owner.
function ChatSession({ open, closeChat, token, disabledReason, inputRef }) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [now, setNow] = useState(Date.now);
  const conversationRef = useRef(null);
  const errorRef = useRef(null);
  const sessionRef = useRef(null);
  const inFlight = useRef(false);
  const activeRequest = useRef(null);
  const alive = useRef(false);
  const lastTurn = turns.at(-1);
  const failed = lastTurn?.state === 'failed' ? lastTurn : null;
  const retryAt = failed?.retryAt || 0;
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const blocked = Boolean(disabledReason || sending || failed);

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
  return (
    <section className="chatbot-panel" id="petcare-chatbot" role="dialog" aria-modal="false" aria-labelledby="chatbot-title" aria-describedby="chatbot-notice">
      <div className="chatbot-header">
        <span className="chatbot-avatar"><Bot size={24} aria-hidden="true" /></span>
        <div><h2 id="chatbot-title">AI Chatbot PetCareShop</h2><p>Trợ lý chăm sóc thú cưng</p></div>
        <button className="chatbot-close icon-button" type="button" aria-label="Đóng chatbot" onClick={closeChat}><X size={21} aria-hidden="true" /></button>
      </div>
      <p className="chatbot-notice" id="chatbot-notice">Hỏi về sản phẩm hoặc cách chăm sóc chó mèo. Giá và tồn kho được đối chiếu tại thời điểm tư vấn.</p>
      {turns.length > 0 && <div className="chatbot-toolbar"><button type="button" onClick={newConversation} disabled={sending}>Cuộc trò chuyện mới</button></div>}
      <div className="chatbot-conversation" ref={conversationRef} role="log" aria-label="Hội thoại chatbot" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {turns.length === 0 ? (
          <div className="chatbot-empty"><Bot size={36} strokeWidth={1.4} aria-hidden="true" /><p>Không gian trò chuyện của bạn</p><span>Bạn muốn tìm sản phẩm hay tìm hiểu cách chăm sóc bé?</span></div>
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
        <input ref={inputRef} type="text" aria-label="Nội dung tin nhắn" aria-describedby="chatbot-notice" placeholder="Nhập nội dung..." maxLength={2000} value={input} onChange={event => setInput(event.target.value)} autoComplete="off" disabled={blocked} />
        <button type="submit" aria-label="Gửi tin nhắn" title="Gửi tin nhắn" disabled={blocked || !input.trim()}><Send size={19} aria-hidden="true" /></button>
      </form>
      <p className="chatbot-footnote">Hội thoại hiển thị trong lần mở trang này. Tải lại trang sẽ bắt đầu phiên mới.</p>
    </section>
  );
}

export default function ChatbotWidget() {
  const { user, authLoading } = useCommerce();
  const [open, setOpen] = useState(false);
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

  const closeChat = () => {
    setOpen(false);
    openerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const handleEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        openerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  return (
    <div className="chatbot-widget">
      <ChatSession key={identity} open={open} closeChat={closeChat} token={user ? token : null} disabledReason={disabledReason} inputRef={inputRef} />
      <button ref={openerRef} className="chatbot-toggle" type="button" aria-label={open ? 'Thu gọn AI Chatbot' : 'Mở AI Chatbot'} aria-expanded={open} aria-controls="petcare-chatbot" onClick={() => open ? closeChat() : setOpen(true)}>
        <Bot size={27} aria-hidden="true" /><span>AI Chatbot</span>
      </button>
    </div>
  );
}
