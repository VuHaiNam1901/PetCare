import { useEffect, useRef } from 'react';

function useFlyToHeader(targetSelector) {
  const flights = useRef(new Set());
  const bounce = useRef(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const cancel = () => {
      for (const stop of flights.current) stop();
      bounce.current?.cancel();
      bounce.current = null;
    };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    window.addEventListener('resize', cancel, { passive: true });
    document.addEventListener('visibilitychange', cancel);
    motion.addEventListener('change', cancel);
    return () => {
      mounted.current = false;
      cancel();
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', cancel);
      motion.removeEventListener('change', cancel);
    };
  }, []);

  return button => {
    let thumbnail, stop;
    try {
      if (!mounted.current || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const target = document.querySelector(targetSelector);
      if (!target?.animate) return;
      const destination = target.getBoundingClientRect();
      if (!destination.width || !destination.height) return;

      const receive = () => {
        if (!mounted.current || !target.isConnected) return;
        bounce.current?.cancel();
        const animation = target.animate([
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(-4px) scale(1.13)', offset: .35 },
          { transform: 'translateY(1px) scale(.97)', offset: .7 },
          { transform: 'translateY(0) scale(1)' },
        ], { duration: 360, easing: 'ease-out' });
        bounce.current = animation;
        animation.onfinish = () => {
          if (bounce.current === animation) bounce.current = null;
          animation.cancel();
        };
      };

      const image = button?.closest('.product-card, .detail-layout')?.querySelector('.product-image img, .detail-image img');
      if (!image?.isConnected || !image.complete || !image.naturalWidth) { receive(); return; }
      const imageRect = image.getBoundingClientRect();
      const headerBottom = target.closest('.site-header').getBoundingClientRect().bottom;
      const imageCenterY = imageRect.top + imageRect.height / 2;
      const visible = imageRect.width > 0 && imageRect.height > 0 && imageCenterY >= headerBottom && imageCenterY <= window.innerHeight && imageRect.right > 0 && imageRect.left < window.innerWidth;
      const origin = visible ? imageRect : button.getBoundingClientRect();
      if (!origin.width || !origin.height) { receive(); return; }

      // Keep only a few compositor animations alive, even after rapid additions.
      if (flights.current.size >= 3) flights.current.values().next().value();
      const size = Math.min(88, origin.width, origin.height);
      const startX = Math.max(size / 2, Math.min(window.innerWidth - size / 2, origin.left + origin.width / 2));
      const startY = Math.max(size / 2, Math.min(window.innerHeight - size / 2, origin.top + origin.height / 2));
      const dx = destination.left + destination.width / 2 - startX;
      const dy = destination.top + destination.height / 2 - startY;
      const distance = Math.hypot(dx, dy);
      const arc = Math.min(140, distance * .22);
      const frames = Array.from({ length: 13 }, (_, index) => {
        const t = index / 12;
        const x = 2 * (1 - t) * t * dx * .45 + t * t * dx;
        const y = 2 * (1 - t) * t * (Math.min(0, dy) - arc) + t * t * dy;
        return { offset: t, transform: `translate3d(${x}px, ${y}px, 0) scale(${1 - .82 * t})`, opacity: t < .82 ? 1 : (1 - t) / .18 };
      });

      thumbnail = document.createElement('img');
      thumbnail.className = 'cart-flight-image';
      thumbnail.src = image.currentSrc || image.src;
      thumbnail.alt = '';
      thumbnail.draggable = false;
      thumbnail.setAttribute('aria-hidden', 'true');
      Object.assign(thumbnail.style, { left: `${startX - size / 2}px`, top: `${startY - size / 2}px`, width: `${size}px`, height: `${size}px` });
      document.body.appendChild(thumbnail);
      const animation = thumbnail.animate(frames, { duration: Math.min(850, 550 + distance * .12), easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
      stop = () => {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        thumbnail.remove();
        flights.current.delete(stop);
      };
      flights.current.add(stop);
      animation.oncancel = stop;
      animation.onfinish = () => { stop(); receive(); };
    } catch {
      // A visual effect must never change the result of adding to the cart.
      if (stop) stop();
      else thumbnail?.remove();
    }
  };
}

export default function useFlyToCart() {
  return useFlyToHeader('.site-header .header-cart-icon');
}

export function useFlyToWishlist() {
  return useFlyToHeader('.site-header .header-wishlist-icon');
}

export function animateWishlistRemoval(button) {
  try {
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const target of [button, document.querySelector('.site-header .header-wishlist-icon')]) {
      if (!target?.isConnected || !target.animate) continue;
      const animation = target.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(.84)', offset: .4 },
        { transform: 'scale(1)' },
      ], { duration: 220, easing: 'ease-out' });
      animation.onfinish = () => animation.cancel();
    }
  } catch { /* Visual feedback must not affect the saved Wishlist result. */ }
}
