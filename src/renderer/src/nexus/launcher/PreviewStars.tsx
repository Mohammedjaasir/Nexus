import { useEffect, useRef } from 'react';

// Deterministic field (no randomness at render), denser near the top.
const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: ((i * 7919) % 1000) / 1000,
  y: ((i * 4013) % 1000) / 1000,
  r: i % 6 ? 0.8 : 1.5,
  p: i * 0.5
}));

/** A faint twinkling starfield behind the preview emblem. It takes its colour
 *  from the element's text colour, which `.nx-prov` sets to the environment's
 *  hue. With reduced motion it draws once and stays still. */
export function PreviewStars() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const cx = cv.getContext('2d'); if (!cx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const size = () => {
      const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d));
      cx.setTransform(d, 0, 0, d, 0, 0);
    };
    const draw = (now: number) => {
      const r = cv.getBoundingClientRect(), t = now / 1000;
      cx.clearRect(0, 0, r.width, r.height);
      cx.fillStyle = getComputedStyle(cv).color;
      for (const s of STARS) {
        cx.globalAlpha = (0.25 + 0.45 * (still ? 0.5 : Math.sin(t * 1.4 + s.p) * 0.5 + 0.5)) * (1 - s.y * 0.7);
        cx.beginPath(); cx.arc(s.x * r.width, s.y * r.height, s.r, 0, Math.PI * 2); cx.fill();
      }
      cx.globalAlpha = 1;
      if (!still) raf = requestAnimationFrame(draw);
    };
    size();
    const ro = new ResizeObserver(() => { size(); if (still) draw(performance.now()); });
    ro.observe(cv);
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="nx-preview__stars" aria-hidden="true" />;
}
