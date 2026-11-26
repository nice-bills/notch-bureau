/* ---------- Notch demo core ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const device = $('.device');
const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
document.addEventListener('touchstart', () => {}, { passive: true }); // lets :active fire on iOS

const money = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const RATE = 15.4; // fake: GHS per USDC
const ghs = (n) => 'GHS ' + Math.round(n * RATE).toLocaleString('en-US');

/* shared demo state (all fake) */
const S = {
  name: 'Ama', seeker: false, base: 45, limit: 45, used: 0, deposit: 0, fee: 0, due: null,
  get avail() { return Math.max(0, this.limit - this.used); },
};

/* ----- router ----- */
const hooks = {};
let stack = [];
function screenEl(id) { return $(`.screen[data-screen="${id}"]`); }
function setSb(el) { device.dataset.sb = el.dataset.sb || 'dark'; }
function markJump(id) { $$('.jump button').forEach(b => b.classList.toggle('on', b.dataset.go === id)); }
function go(id, opt = {}) {
  const next = screenEl(id); if (!next) return;
  const curId = stack[stack.length - 1];
  const cur = curId && screenEl(curId);
  if (cur === next) return;
  if (opt.tab || opt.reset) {
    $$('.screen').forEach(s => { s.classList.add('notrans'); s.classList.remove('is-active', 'is-behind'); });
    next.classList.add('is-active');
    void next.offsetWidth;
    $$('.screen').forEach(s => s.classList.remove('notrans'));
    if (!RM) next.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: opt.reset ? 260 : 200, easing: 'cubic-bezier(.23,1,.32,1)' });
    stack = opt.reset ? [id] : [...stack.slice(0, -1), id];
  } else {
    if (cur) { cur.classList.remove('is-active'); cur.classList.add('is-behind'); }
    next.classList.remove('is-behind'); next.classList.add('is-active');
    stack.push(id);
  }
  if (cur && hooks[curId]?.leave) hooks[curId].leave();
  setSb(next); markJump(id); closeSheet();
  hooks[id]?.enter && hooks[id].enter(opt);
}
function back() {
  if (stack.length < 2) {
    // after a side-panel jump there is no history: step back through the flow instead of doing nothing
    const order = $$('.jump button').map(b => b.dataset.go), i = order.indexOf(stack[0]);
    if (i > 0) { const prev = order[i - 1]; if (window.prepareJump) window.prepareJump(prev, i - 1); go(prev, { reset: true }); }
    return;
  }
  const curId = stack.pop(); const cur = screenEl(curId);
  const prevId = stack[stack.length - 1]; const prev = screenEl(prevId);
  cur.classList.remove('is-active');
  prev.classList.remove('is-behind'); prev.classList.add('is-active');
  hooks[curId]?.leave && hooks[curId].leave();
  setSb(prev); markJump(prevId);
  hooks[prevId]?.enter && hooks[prevId].enter({ back: true });
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { const id = g.dataset.go; if (g.closest('.jump')) jumpTo(id); else go(id, { tab: g.hasAttribute('data-tab') }); return; }
  if (e.target.closest('[data-back]')) back();
  const o = e.target.closest('[data-sheet-open]'); if (o) openSheet(o.dataset.sheetOpen);
  if (e.target.closest('[data-sheet-close]') || e.target.classList.contains('scrim')) closeSheet();
});
/* jumper on desktop side panel: prepare state so any screen renders sensibly */
function jumpTo(id) {
  const order = $$('.jump button').map(b => b.dataset.go);
  const i = order.indexOf(id);
  if (window.prepareJump) window.prepareJump(id, i);
  go(id, { reset: true });
}

/* ----- press feedback (pointer-down, no 300ms wait) ----- */
document.addEventListener('pointerdown', (e) => { const t = e.target.closest('.tap'); if (t) { t.classList.add('down'); } });
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => document.addEventListener(ev, () => $$('.tap.down').forEach(t => t.classList.remove('down')), true));

/* ----- number roll ----- */
function roll(el, to, o = {}) {
  if (!el) return;
  const from = o.from ?? parseFloat(el.dataset.v || 0);
  const dur = RM ? 1 : (o.dur ?? 900);
  const fmt = o.fmt || ((v) => money(v, o.dec ?? 2));
  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const k = p === 1 ? 1 : 1 - Math.pow(2, -10 * p); // ease-out-expo
    const v = from + (to - from) * k;
    el.innerHTML = fmt(v);
    if (p < 1) el._raf = requestAnimationFrame(step); else { el.dataset.v = to; o.done && o.done(); }
  };
  el._raf = requestAnimationFrame(step);
}
/* split money: big whole + muted cents */
const split = (v) => { const s = money(v); const [a, b] = s.split('.'); return `${a}<span class="cents">.${b}</span>`; };

/* ----- sheets with drag-to-dismiss + velocity ----- */
let openId = null;
function openSheet(id) {
  const sh = $(`.sheet[data-sheet="${id}"]`); if (!sh) return;
  closeSheet(true);
  openId = id; sh.scrollTop = 0;
  sh._onOpen && sh._onOpen();
  window.onSheet && window.onSheet(id, sh);
  $('.scrim').classList.add('on'); sh.style.transform = ''; sh.classList.add('on'); buzz(6);
}
function closeSheet(quiet) {
  $$('.sheet.on').forEach(s => { s.classList.remove('on'); s.style.transform = ''; });
  $('.scrim')?.classList.remove('on'); openId = null;
}
function rubber(x, d = 300, c = 0.55) { return (x * d * c) / (d + c * Math.abs(x)); }
$$('.sheet').forEach((sh) => {
  let y0 = null, last = [], h = 0, dragging = false;
  sh.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,input,a,.nodrag') || sh.scrollTop > 0) return;
    y0 = e.clientY; h = sh.offsetHeight; last = [{ y: e.clientY, t: e.timeStamp }]; dragging = false;
  });
  sh.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    if (!dragging && Math.abs(dy) > 6) { dragging = true; sh.setPointerCapture(e.pointerId); sh.style.transition = 'none'; }
    if (!dragging) return;
    sh.style.transform = `translate3d(0,${dy > 0 ? dy : rubber(dy, 200)}px,0)`;
    last.push({ y: e.clientY, t: e.timeStamp }); if (last.length > 5) last.shift();
  });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null; sh.style.transition = '';
    if (!dragging) return; dragging = false;
    const a = last[0], b = last[last.length - 1];
    const v = (b.y - a.y) / Math.max(1, b.t - a.t); // px/ms
    if (dy > h * 0.28 || v > 0.45) closeSheet(); else sh.style.transform = '';
  };
  sh.addEventListener('pointerup', end); sh.addEventListener('pointercancel', end);
});

/* ----- toast ----- */
let toastT;
function toast(msg) {
  const t = $('.toast'); if (!t) return;
  t.querySelector('span').textContent = msg; t.classList.add('on'); buzz(10);
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1700);
}
function copyText(txt) {
  try { navigator.clipboard.writeText(txt).catch(() => {}); } catch (e) {}
  toast('Copied');
}

/* ----- hold-to-confirm ----- */
function holdButton(btn, ms, onDone) {
  let t = null, t0 = 0;
  const start = (e) => { if (btn.disabled) return; t0 = performance.now(); btn.classList.add('holding'); buzz(5); t = setTimeout(() => { t = null; btn.classList.remove('holding'); btn.classList.add('held'); buzz(18); onDone(); setTimeout(() => btn.classList.remove('held'), 600); }, ms); };
  const stop = () => { if (t && performance.now() - t0 < ms * .4) toast('Press and hold to confirm'); clearTimeout(t); t = null; btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDone(); } });
}

/* ----- timers that die with their screen ----- */
function timers() { const ids = []; return { at(ms, fn) { ids.push(setTimeout(fn, RM ? Math.min(ms, 300) : ms)); }, clear() { ids.forEach(clearTimeout); ids.length = 0; } }; }

/* date helpers (fixed "today" for the demo) */
const TODAY = new Date(2026, 10, 25);
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
