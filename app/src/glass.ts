// Liquid Glass light: the rim (--la) and bloom (--lx/--ly) follow the pointer, the phone's tilt and scrolling.
// Chromium also gets real refraction: a per-element SVG displacement map on the backdrop (`.lens` elements).
const mq = (q: string) => typeof matchMedia !== 'undefined' && matchMedia(q).matches;

export function startLight(): () => void {
  if (mq('(prefers-reduced-motion: reduce)')) return () => {};
  const root = document.documentElement;
  let raf = 0, tx = 0.3, ty = 0;
  const apply = () => {
    raf = 0;
    root.style.setProperty('--lx', `${(10 + tx * 80).toFixed(1)}%`);
    root.style.setProperty('--ly', `${(-20 + ty * 60).toFixed(1)}%`);
    root.style.setProperty('--la', `${(150 + tx * 140).toFixed(1)}deg`);
  };
  const set = (x: number, y: number) => { tx = Math.max(0, Math.min(1, x)); ty = Math.max(0, Math.min(1, y)); if (!raf) raf = requestAnimationFrame(apply); };
  const onMove = (e: PointerEvent) => set(e.clientX / innerWidth, e.clientY / innerHeight);
  const onTilt = (e: DeviceOrientationEvent) => { if (e.gamma == null || e.beta == null) return; set(0.5 + e.gamma / 60, 0.5 + (e.beta - 45) / 90); };
  const onScroll = () => set(tx, 0.3 + (scrollY % 400) / 1000);
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('deviceorientation', onTilt);
  addEventListener('scroll', onScroll, { passive: true });
  return () => { removeEventListener('pointermove', onMove); removeEventListener('deviceorientation', onTilt); removeEventListener('scroll', onScroll); };
}

const REFRACT = typeof window !== 'undefined' && !mq('(prefers-reduced-transparency: reduce)') && !mq('(prefers-contrast: more)')
  && 'chrome' in window && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#x)');

function lensMap(w: number, h: number, e: number): string {
  const fx = Math.min(0.5, e / w), fy = Math.min(0.5, e / h);
  const st = (f: number, c: (v: number) => string) => ([[0, 255], [f * 0.3, 205], [f * 0.65, 158], [f, 128], [1 - f, 128], [1 - f * 0.65, 98], [1 - f * 0.3, 51], [1, 0]] as const).map(([o, v]) => `<stop offset="${o.toFixed(4)}" stop-color="${c(v)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="a" x2="1">${st(fx, (v) => `rgb(${v},0,0)`)}</linearGradient><linearGradient id="b" x2="0" y2="1">${st(fy, (v) => `rgb(0,${v},0)`)}</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#a)"/><rect width="${w}" height="${h}" fill="url(#b)" style="mix-blend-mode:screen"/></svg>`;
}
let lensN = 0;
/** Give every `.lens` element in scope a displacement filter sized to it (once per size). */
export function buildLenses(scope: ParentNode = document) {
  if (!REFRACT) return;
  const defs = document.querySelector('#fx defs');
  if (!defs) return;
  scope.querySelectorAll<HTMLElement>('.lens').forEach((el) => {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    const key = `${w}x${h}`;
    if (el.dataset.lk === key) return;
    el.dataset.lk = key;
    const id = el.dataset.lid || `lg${lensN++}`;
    el.dataset.lid = id;
    const e = Math.min(h / 2, 22), scale = Math.min(34, h * 0.55), blur = h > 60 ? 3 : 2;
    document.getElementById(id)?.remove();
    defs.insertAdjacentHTML('beforeend', `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/><feImage href="data:image/svg+xml,${encodeURIComponent(lensMap(w, h, e))}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="m"/><feDisplacementMap in="b" in2="m" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="d"/><feColorMatrix in="d" type="saturate" values="1.9"/></filter>`);
    el.style.backdropFilter = `url(#${id})`;
  });
}

export const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };
