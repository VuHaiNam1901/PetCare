import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const POSITION_KEY = 'petcare.chatbot-position.v1';
const margin = 12;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
function viewport() {
  const area = window.visualViewport;
  return { x: area?.offsetLeft || 0, y: area?.offsetTop || 0, width: area?.width || window.innerWidth, height: area?.height || window.innerHeight };
}
function savedPosition() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY) || 'null');
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
  } catch { return null; }
}
function savePosition(position) {
  try { sessionStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Dragging still works without storage. */ }
}

export default function useChatbotDrag(open, identity) {
  const widgetRef = useRef(null);
  const panelRef = useRef(null);
  const position = useRef(null);
  const gesture = useRef(null);
  const frame = useRef(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  const paint = useCallback(next => {
    const widget = widgetRef.current;
    if (!widget) return;
    const area = viewport();
    const size = widget.offsetWidth;
    const insetX = Math.min(margin, Math.max(0, (area.width - size) / 2));
    const insetY = Math.min(margin, Math.max(0, (area.height - size) / 2));
    const x = clamp(next?.x ?? area.x + area.width - size - 20, area.x + insetX, area.x + area.width - size - insetX);
    const y = clamp(next?.y ?? area.y + area.height - size - 20, area.y + insetY, area.y + area.height - size - insetY);
    position.current = { x, y };
    widget.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const panel = panelRef.current;
    if (!panel) return;
    const width = Math.min(355, area.width - margin * 2);
    const height = Math.min(480, area.height - margin * 2);
    let panelX = x + size - width;
    let panelY = y - height - margin;
    if (panelY < area.y + margin) {
      panelY = y + size + margin;
      if (panelY + height > area.y + area.height - margin) {
        panelY = y - height - margin;
        if (x - width - margin >= area.x + margin) panelX = x - width - margin;
        else if (x + size + width + margin <= area.x + area.width - margin) panelX = x + size + margin;
      }
    }
    Object.assign(panel.style, {
      width: `${width}px`, height: `${height}px`,
      transform: `translate3d(${clamp(panelX, area.x + margin, area.x + area.width - width - margin)}px, ${clamp(panelY, area.y + margin, area.y + area.height - height - margin)}px, 0)`,
    });
  }, []);

  useLayoutEffect(() => { paint(position.current || savedPosition()); }, [open, identity, paint]);

  useEffect(() => {
    const resize = () => { paint(position.current); if (position.current) savePosition(position.current); };
    const restore = event => {
      if (!event.persisted) return;
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      gesture.current = null; suppressClick.current = false; setDragging(false);
      paint(savedPosition() || position.current);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('pageshow', restore);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('pageshow', restore);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [paint]);

  const pointerDown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: position.current, moved: false, next: position.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = event => {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; setDragging(true); }
    event.preventDefault();
    drag.next = { x: drag.start.x + dx, y: drag.start.y + dy };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; if (gesture.current) paint(gesture.current.next); });
  };
  const pointerEnd = event => {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (drag.moved) {
      paint(drag.next); savePosition(position.current); suppressClick.current = true;
    }
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const consumeDragClick = event => {
    if (!suppressClick.current || (event.detail === 0 && !event.nativeEvent.pointerType)) return false;
    suppressClick.current = false;
    event.preventDefault(); event.stopPropagation();
    return true;
  };

  return { widgetRef, panelRef, dragging, consumeDragClick,
    dragEvents: { onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerEnd, onPointerCancel: pointerEnd, onLostPointerCapture: pointerEnd } };
}
