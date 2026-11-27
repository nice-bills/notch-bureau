// First run, as a pitch: what Notch does, what the money is for, how money comes in, why it is safe, what it costs,
// then the wallet, at the moment it is needed. One question per screen, a tap answers it, Back always works and every
// answer is kept on this phone (onboard.ts). The rest (inbox, waiting, the limit, the first loan) runs on the real
// screens with the same progress bar.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUi, Banners } from './App';
import { envelope, stamp, type Ink, type Motif } from './art';
import { depositNeededFor, feeFor, payoffFor } from './notch';
import { formatUsdc } from './amount';
import { Btn, Icon, cx } from './ui';
import { GOALS, PAID, STEP, STEPS, forGoal, getOnboard, setOnboard, useOnboard, type Goal, type Paid } from './onboard';
import { buzz } from './glass';

/** The progress bar: always the same ten steps, from the promise to the first loan. It remembers where it last stood,
 * so moving to the next step (even onto a different screen, like Get your limit) fills from there instead of jumping. */
let lastAt = -1;
export function Progress({ at }: { at: number }) {
  const [shown, setShown] = useState(() => (lastAt >= 0 && lastAt !== at ? lastAt : at));
  useEffect(() => {
    lastAt = at;
    if (shown === at) return;
    const f = requestAnimationFrame(() => requestAnimationFrame(() => setShown(at)));
    return () => cancelAnimationFrame(f);
  }, [at, shown]);
  return (
    <div className="onb-bar" role="progressbar" aria-label="Getting started" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={at + 1} aria-valuetext={`Step ${at + 1} of ${STEPS}`}>
      <i style={{ transform: `scaleX(${(shown + 1) / STEPS})` }} />
    </div>
  );
}

/** Forward: a history entry per step, so the browser's (and Android's) Back walks back through the questions. */
function goStep(n: number) {
  setOnboard({ step: n });
  try { history.pushState({ notchOnb: n }, ''); } catch { /* sandboxed: the on-screen Back still works */ }
  window.scrollTo({ top: 0 });
}
function backStep(from: number) {
  const st = history.state as { notchOnb?: number } | null;
  if (st?.notchOnb === from) { history.back(); return; } // popstate below sets the step
  const to = Math.max(0, from - 1);
  setOnboard({ step: to });
  try { history.replaceState({ notchOnb: to }, ''); } catch { /* ignore */ }
}

const still = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const LABEL: Record<number, string> = {
  [STEP.goal]: 'What’s the money for?', [STEP.paid]: 'How does your money come in?', [STEP.private]: 'Your statement stays private',
  [STEP.costs]: 'What it costs', [STEP.prime]: 'Connect your wallet',
};

export function Onboarding() {
  const o = useOnboard();
  // Browser or Android Back between questions.
  useEffect(() => {
    const on = () => {
      const n = (history.state as { notchOnb?: number } | null)?.notchOnb;
      setOnboard({ step: typeof n === 'number' ? n : 0 });
    };
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  // Never past a question that has no answer yet; the wallet steps (6+) start again at the wallet screen when signed out.
  let step = Math.min(o.step, STEP.prime);
  if (step > STEP.goal && !o.goal) step = STEP.goal;
  if (step > STEP.paid && !o.paid) step = STEP.paid;
  // which way we moved: forward slides in from the right, Back from the left
  const prev = useRef(step);
  const dir = step < prev.current ? 'back' : 'fwd';
  useEffect(() => { prev.current = step; }, [step]);

  if (step === STEP.promise) return <Pitch />;
  let screen: ReactNode;
  switch (step) {
    case STEP.goal: screen = <Choose step={step} title="What’s the money for?" sub="Pick one. We set things up around it." options={GOALS.map((g) => ({ ...g, sub: undefined }))} art={GOAL_ART} value={o.goal} onPick={(g) => setOnboard({ goal: g as Goal })} caption={(id) => `For ${forGoal(id as Goal)}`} />; break;
    case STEP.paid: screen = <Choose step={step} title="How does your money come in?" sub="So we ask for the right statement." options={PAID} art={PAID_ART} value={o.paid} onPick={(p) => setOnboard({ paid: p as Paid })} caption={(id) => PAID.find((x) => x.id === id)?.sub ?? ''} />; break;
    case STEP.private: screen = <Private goal={o.goal} />; break;
    case STEP.costs: screen = <Costs goal={o.goal} />; break;
    default: screen = <Prime paid={o.paid} />;
  }
  return (
    <section className="onb" aria-label={LABEL[step]} data-step={step}>
      <div className="onb-top">
        <button type="button" className="circ glass lens tap" onClick={() => backStep(step)} aria-label="Back" data-onb-back><Icon name="back" /></button>
        <Progress at={step} />
      </div>
      <div key={step} className="onb-screen" data-dir={dir}>{screen}</div>
    </section>
  );
}

/** One onboarding screen: the content, then (if any) the main button, kept in reach above the browser bar. */
function Frame({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="onb-body">{children}</div>
      {foot && <div className="onb-foot">{foot}<p className="welcome-dev">Solana devnet only. Test money, no real funds.</p></div>}
    </>
  );
}

/** Replays a one-shot illustration when tapped (the sequence never loops on its own). */
function useReplay() {
  const [n, setN] = useState(0);
  return [n, () => { if (!still()) { setN((x) => x + 1); buzz(6); } }] as const;
}

// ---- 0. the promise: a full-page stamp wall you can play with ----------------------------------------------------
// Each stamp on the wall is a payment from someone's money history. Tap one and it flies onto the envelope, and the
// example limit on the envelope grows. Near the finger the stamps lift; the envelope leans toward it. It is the pitch
// as a toy: your history becomes your limit.
const WALL: [Ink, Motif, number][] = [['verm', 'sun', 5], ['ultra', 'bank', 10], ['ochre', 'kente', 20], ['sea', 'waves', 2], ['verm', 'horn', 1], ['ultra', 'waves', 50], ['ochre', 'sun', 5], ['sea', 'kente', 10]];
const CAPS = ['GHANA', 'NOTCH', 'AIRMAIL', 'ACCRA', 'POSTE', 'KUMASI', 'TAMALE', 'CEDI'];
const ROWS = 8, COLS = 7;
const MAX_EXAMPLE = 500;
// a limit is a slice of what moves through your account, never all of it
const SHARE = 0.25;

function Pitch() {
  const { openSignIn, go } = useUi();
  const wall = useMemo(() => {
    let html = '';
    for (let r = 0; r < ROWS; r++) {
      html += '<div class="row">';
      for (let i = 0; i < COLS; i++) {
        const [ink, mo, num] = WALL[(i * 3 + r * 5) % WALL.length];
        html += `<span class="st" data-v="${num}" data-ink="${ink}" data-mo="${mo}" style="--d:${((i * 7 + r * 3) % 11) * 40}ms"><svg viewBox="0 0 88 104">${stamp(88, 104, { ink, motif: mo, num: String(num), cap: CAPS[(i + r * 2) % CAPS.length] })}</svg></span>`;
      }
      html += '</div>';
    }
    return html;
  }, []);
  const env = useMemo(() => envelope(), []);
  const root = useRef<HTMLElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const [got, setGot] = useState({ n: 0, sum: 0, total: 0 });
  const [bump, setBump] = useState(0);
  const mark = useMemo(() => stamp(88, 104, { ink: 'verm', motif: 'kente', num: String(got.total), cap: 'USDC', top: 'LIMIT', numSize: got.total >= 100 ? 26 : 30 }), [got.total]);
  const still = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // the stamps near the finger lift; the envelope leans toward it; the wall drifts the other way
  const frame = useRef(0);
  const lean = (e: React.PointerEvent) => {
    const el = root.current;
    if (!el || still()) return;
    const { clientX: px, clientY: py } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--lx', Math.max(-1, Math.min(1, ((px - r.left) / r.width) * 2 - 1)).toFixed(3));
      el.style.setProperty('--ly', Math.max(-1, Math.min(1, ((py - r.top) / r.height) * 2 - 1)).toFixed(3));
      wallRef.current?.querySelectorAll<HTMLElement>('.st').forEach((s) => {
        const b = s.getBoundingClientRect();
        const d = Math.hypot(b.left + b.width / 2 - px, b.top + b.height / 2 - py);
        const k = Math.max(0, 1 - d / 130);
        s.style.setProperty('--k', k.toFixed(3));
      });
    });
  };
  const settle = () => {
    cancelAnimationFrame(frame.current);
    root.current?.style.setProperty('--lx', '0');
    root.current?.style.setProperty('--ly', '0');
    wallRef.current?.querySelectorAll<HTMLElement>('.st').forEach((s) => s.style.setProperty('--k', '0'));
  };

  // tap a stamp: it flies onto the envelope and the example limit grows
  const collect = (e: React.MouseEvent) => {
    const s = (e.target as HTMLElement).closest<HTMLElement>('.st');
    if (!s || s.classList.contains('used')) return;
    const v = Number(s.dataset.v) || 0;
    s.classList.add('used');
    buzz(12);
    const add = () => { setGot((g) => ({ n: g.n + 1, sum: g.sum + v, total: Math.min(MAX_EXAMPLE, Math.round((g.sum + v) * SHARE)) })); setBump((b) => b + 1); };
    const to = markRef.current?.getBoundingClientRect();
    const from = s.getBoundingClientRect();
    if (!to || still() || !('animate' in document.body)) { add(); return; }
    const fly = document.createElement('div');
    fly.className = 'st-fly';
    fly.innerHTML = s.innerHTML;
    Object.assign(fly.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.appendChild(fly);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const sc = to.width / from.width;
    const anim = fly.animate([
      { transform: 'translate(0,0) rotate(-7deg) scale(1)', offset: 0 },
      { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 60}px) rotate(8deg) scale(${(1 + sc) / 2 + 0.25})`, offset: 0.55 },
      { transform: `translate(${dx}px,${dy}px) rotate(-8deg) scale(${sc})`, offset: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)' });
    anim.onfinish = () => { fly.remove(); add(); };
  };
  const reset = () => {
    if (!got.n) { root.current?.querySelector('.welcome-live .hero')?.animate([{ transform: 'rotate(-4deg) translateX(0)' }, { transform: 'rotate(-4deg) translateX(-6px)' }, { transform: 'rotate(-4deg) translateX(6px)' }, { transform: 'rotate(-4deg) translateX(0)' }], { duration: 260 }); buzz(6); return; }
    wallRef.current?.querySelectorAll('.st.used').forEach((s) => s.classList.remove('used'));
    setGot({ n: 0, sum: 0, total: 0 });
    buzz(6);
  };

  const hint = got.n === 0
    ? 'Tap the stamps. Each one is a payment in your money history.'
    : `${got.n} payment${got.n === 1 ? '' : 's'} (${got.sum} in) → a ${got.total} USDC limit (example). Yours comes from your real statement.`;

  return (
    <section ref={root} className={cx('welcome', 'welcome-live', got.n > 0 && 'is-stamped')} aria-labelledby="p-h" data-step={0} onPointerMove={lean} onPointerLeave={settle} onPointerUp={(e) => { if (e.pointerType !== 'mouse') settle(); }}>
      <div ref={wallRef} className="wall" aria-hidden="true" onClick={collect}><div className="rows" dangerouslySetInnerHTML={{ __html: wall }} /></div>
      <div className="wall-fade" aria-hidden="true" />
      <div className="brandpill glass lens">
        <svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="8" fill="#111A33" /><path d="M8.5 18V8.5l9 9V8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        notch
      </div>
      <Banners />
      <div className="lede">
        <h1 id="p-h">Credit from the money history you already have.</h1>
        <p>No bank account, no credit score, no land or car to pledge. Your money statement is the proof.</p>
      </div>
      <button type="button" className="hero" onClick={reset} aria-label={got.n ? `Example limit ${got.total} USDC. Tap to start over.` : 'Envelope. Tap the stamps around it to build an example limit.'}>
        <svg viewBox="0 0 312 204" aria-hidden="true" dangerouslySetInnerHTML={{ __html: env }} />
        <span ref={markRef} key={bump} className="hero-mark" aria-hidden="true"><svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: mark }} /></span>
      </button>
      <p className="hero-hint glass" aria-live="polite">{hint}</p>
      <div className="foot">
        <Btn onClick={() => goStep(STEP.goal)}>Get started</Btn>
        <div className="onb-links">
          <button type="button" className="textlink" onClick={openSignIn}>I already use Notch</button>
          <button type="button" className="textlink" onClick={() => go('lend')}>I want to lend</button>
        </div>
        <p className="welcome-dev">Solana devnet only. Test money, no real funds.</p>
      </div>
    </section>
  );
}

// ---- 1, 2. one question, tap to answer -----------------------------------------------------------------------------
// The answers sit right under the question; below them, a fan of stamps, one per answer. Picking one thuds its stamp
// down in front and postmarks it, then the next question slides in.
type Opt = { id: string; label: string; sub?: string; icon: Parameters<typeof Icon>[0]['name'] };
type Art = Record<string, { ink: Ink; motif: Motif; cap: string }>;
const GOAL_ART: Art = {
  stock: { ink: 'ochre', motif: 'shop', cap: 'SHOP' },
  school: { ink: 'ultra', motif: 'cap', cap: 'SCHOOL' },
  emergency: { ink: 'verm', motif: 'bolt', cap: 'URGENT' },
  bills: { ink: 'sea', motif: 'bill', cap: 'BILLS' },
};
const PAID_ART: Art = {
  momo: { ink: 'ochre', motif: 'phone', cap: 'MOMO' },
  bank: { ink: 'ultra', motif: 'bank', cap: 'BANK' },
  both: { ink: 'sea', motif: 'both', cap: 'BOTH' },
};

function Choose({ step, title, sub, options, art, value, onPick, caption }: { step: number; title: string; sub: string; options: Opt[]; art: Art; value?: string; onPick: (id: string) => void; caption: (id: string) => string }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [thud, setThud] = useState(0);
  const pick = (id: string) => {
    onPick(id);
    buzz(8);
    setThud((n) => n + 1);
    clearTimeout(timer.current);
    // a beat to see the stamp land, then on to the next screen
    timer.current = setTimeout(() => { if (getOnboard().step === step) goStep(step + 1); }, still() ? 240 : 620);
  };
  return (
    <Frame>
      <h1 className="onb-h">{title}</h1>
      <p className="onb-p">{sub}</p>
      <div className="choices" role="radiogroup" aria-label={title}>
        {options.map((x, i) => (
          <button key={x.id} type="button" role="radio" aria-checked={value === x.id} className={cx('choice tap', value === x.id && 'on')} style={{ '--i': i } as React.CSSProperties} onClick={() => pick(x.id)}>
            <span className="choice-ico"><Icon name={x.icon} /></span>
            <span className="t"><b>{x.label}</b>{x.sub && <small>{x.sub}</small>}</span>
            <span className="choice-ck" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" pathLength={1} /></svg></span>
          </button>
        ))}
      </div>
      <StampFan ids={options.map((x) => x.id)} art={art} value={value} thud={thud} caption={value ? caption(value) : 'Pick one above'} />
    </Frame>
  );
}

/** The stamps, fanned out. The picked one comes to the front with a thud, a postmark and a puff of ink. */
function StampFan({ ids, art, value, thud, caption }: { ids: string[]; art: Art; value?: string; thud: number; caption: string }) {
  const svgs = useMemo(() => Object.fromEntries(ids.map((id) => [id, stamp(88, 104, { ...art[id], num: '', top: 'NOTCH', ms: 0.92 })])), [ids, art]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thud || still() || !value) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-id="${value}"] .sf-in`);
    if (!el?.animate) return;
    el.animate([
      { transform: 'translateY(-46px) scale(1.5) rotate(-10deg)', opacity: 0.4, filter: 'drop-shadow(0 26px 18px rgba(17,26,51,.25))' },
      { transform: 'translateY(0) scale(.94) rotate(1deg)', opacity: 1, offset: 0.62 },
      { transform: 'none', opacity: 1 },
    ], { duration: 420, easing: 'cubic-bezier(.23,1,.32,1)' });
    // the paper under it gives a little on impact
    box.current?.animate([{ transform: 'none' }, { transform: 'translateY(3px) scale(.99)', offset: 0.6 }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
    const t = setTimeout(() => buzz(14), 260);
    return () => clearTimeout(t);
  }, [thud, value]);
  const n = ids.length, p = value ? ids.indexOf(value) : -1;
  return (
    <div ref={box} className={cx('onb-stage sfan', p >= 0 && 'picked')} aria-hidden="true">
      <div className="sf-row">
        {ids.map((id, i) => {
          const c = i - (n - 1) / 2;
          // picked: the others close up into a hand of cards behind it
          const k = (p >= 0 ? (i < p ? i : i - 1) : 0) - (n - 2) / 2;
          const tf = p < 0
            ? `translate(${c * 58}%, ${Math.abs(c) * 7}%) rotate(${c * 9}deg)`
            : i === p
              ? 'translate(0, -2%) rotate(-4deg) scale(1.22)'
              : `translate(${k * 72}%, ${6 + Math.abs(k) * 6}%) rotate(${k * 13}deg) scale(.84)`;
          return (
            <span key={id} data-id={id} className={cx('sf', i === p && 'on', p >= 0 && i !== p && 'off')} style={{ transform: tf, zIndex: i === p ? 9 : 5 - Math.abs(Math.round(c)) }}>
              <span className="sf-in" style={{ '--i': i } as React.CSSProperties}>
                <svg className="sf-svg" viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: svgs[id] }} />
                {i === p && <Postmark key={thud} />}
              </span>
            </span>
          );
        })}
      </div>
      <p className="sf-cap" key={caption}>{caption}</p>
    </div>
  );
}

/** A round postmark with wavy cancel lines that draw themselves over a stamp. */
function Postmark() {
  return (
    <svg className="pm" viewBox="0 0 120 70">
      <circle cx="34" cy="35" r="24" pathLength={1} />
      <circle cx="34" cy="35" r="18.5" pathLength={1} />
      <text x="34" y="32" textAnchor="middle">NOTCH</text>
      <text x="34" y="44" textAnchor="middle">ACCRA</text>
      {[22, 32, 42, 52].map((y) => <path key={y} d={`M62 ${y}q7-6 14 0t14 0t14 0t14 0`} pathLength={1} />)}
    </svg>
  );
}

// ---- 3. belief: it stays private (true facts only) -----------------------------------------------------------------
// The statement slides into a sealed box; only a limit stamp comes out; where the statement was, an empty outline.
function Private({ goal }: { goal?: Goal }) {
  const what = 'statement';
  const [run, replay] = useReplay();
  const out = useMemo(() => stamp(88, 104, { ink: 'verm', motif: 'kente', num: '#', cap: 'LIMIT', top: 'ONE NUMBER' }), []);
  return (
    <Frame foot={<Btn onClick={() => goStep(STEP.costs)}>Next</Btn>}>
      <p className="onb-eyebrow">For {forGoal(goal)}</p>
      <h1 className="onb-h">Your {what} stays private.</h1>
      <div className="onb-stage pv" key={run} onClick={replay} aria-hidden="true">
        <div className="pv-lane">
          <div className="pv-slot">
            <span className="pv-ghost">deleted</span>
            <div className="pv-doc">
              <b>Statement</b>
              {[0.9, 0.7, 0.82, 0.6, 0.76].map((w, i) => <i key={i} style={{ width: `${w * 100}%` }} />)}
            </div>
          </div>
          <div className="pv-box">
            <span className="pv-scan" />
            <svg viewBox="0 0 24 24" className="pv-lock"><path className="pv-shackle" d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /><rect x="5" y="10.5" width="14" height="10" rx="2.5" /></svg>
            <small>SEALED</small>
          </div>
          <div className="pv-out"><svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: out }} /></div>
        </div>
        <div className="pv-legend"><span>your payments</span><span>read here</span><span>your limit</span></div>
      </div>
      <ul className="facts onb-facts">
        <li className="fact" style={{ '--i': 0 } as React.CSSProperties}><Icon name="lock" /><span><b>Read inside sealed hardware</b><small>Your transaction history is read there. Nobody can look inside, not even us.</small></span></li>
        <li className="fact" style={{ '--i': 1 } as React.CSSProperties}><Icon name="shield" /><span><b>Only one number leaves</b><small>Your limit. Not your name, not your payments.</small></span></li>
        <li className="fact" style={{ '--i': 2 } as React.CSSProperties}><Icon name="check" /><span><b>Nothing is kept</b><small>The {what} is deleted once it is read.</small></span></li>
      </ul>
    </Frame>
  );
}

// ---- 4. belief: the cost, before anything is asked -----------------------------------------------------------------
// The example as a row of stamps, landing in order: borrow 50, put 10 down, a 1 fee, pay 51 back, and the 10 flies back.
const EG = 50_000_000n;
function Costs({ goal }: { goal?: Goal }) {
  const dep = depositNeededFor(EG), fee = feeFor(EG), pay = payoffFor(EG);
  const f = (v: bigint) => formatUsdc(v).replace(/\.00$/, '');
  const [run, replay] = useReplay();
  const row = useMemo(() => ([
    { num: f(EG), cap: 'BORROW', ink: 'ultra', motif: 'bank', label: 'Borrow' },
    { num: f(dep), cap: 'DOWN', ink: 'ochre', motif: 'kente', label: 'Down' },
    { num: f(fee), cap: 'FEE', ink: 'verm', motif: 'sun', label: 'Fee' },
    { num: f(pay), cap: 'PAID', ink: 'ultra', motif: 'waves', label: 'Pay back' },
    { num: `+${f(dep)}`, cap: 'BACK', ink: 'sea', motif: 'kente', label: 'Back' },
  ] as const).map((x) => ({ ...x, svg: stamp(88, 104, { ink: x.ink, motif: x.motif, num: x.num, cap: x.cap, numSize: x.num.length > 2 ? 26 : 30 }) })), [dep, fee, pay]);
  return (
    <Frame foot={<Btn onClick={() => goStep(STEP.prime)}>Next</Btn>}>
      <p className="onb-eyebrow">For {forGoal(goal)}</p>
      <h1 className="onb-h">The cost, up front.</h1>
      <p className="onb-p">Say you borrow {f(EG)} USDC:</p>
      <div className="onb-stage cs" key={run} onClick={replay} aria-hidden="true">
        <div className="cs-row">
          {row.map((x, i) => (
            <span key={x.cap} className={cx('cs-st', i === 4 && 'back')} style={{ '--i': i } as React.CSSProperties}>
              <svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: x.svg }} />
              <small>{x.label}</small>
            </span>
          ))}
        </div>
      </div>
      <div className="rcpt pcard onb-rcpt" data-testid="cost-example">
        <div className="r" style={{ '--i': 1 } as React.CSSProperties}><span>You put down, 20%<small>Comes back when you pay</small></span><b>{f(dep)}</b></div>
        <div className="r" style={{ '--i': 2 } as React.CSSProperties}><span>Fee, 2%</span><b>{f(fee)}</b></div>
        <div className="r total" style={{ '--i': 3 } as React.CSSProperties}><span>You pay back</span><b>{f(pay)}</b></div>
        <div className="r" style={{ '--i': 4 } as React.CSSProperties}><span>Deposit back</span><b style={{ color: 'var(--green)' }}>+{f(dep)}</b></div>
      </div>
      <p className="help onb-note"><Icon name="clock" />Your limit lasts 30 days. Pay back within 30 days.</p>
    </Frame>
  );
}

// ---- 5. the wallet, primed: why, and what will pop up --------------------------------------------------------------
// A small phone plays the two asks in order: pick your wallet from a list, then sign one message (a stamp seals it).
function Prime({ paid }: { paid?: Paid }) {
  const { openSignIn, pollar } = useUi();
  const bank = paid === 'bank';
  const [run, replay] = useReplay();
  const seal = useMemo(() => stamp(88, 104, { ink: 'verm', motif: 'horn', num: '✓', cap: 'YOURS', top: 'INBOX', numSize: 28 }), []);
  return (
    <Frame foot={<><Btn onClick={openSignIn}>Connect wallet</Btn><p className="help" style={{ textAlign: 'center', margin: '4px 0 0' }}>Notch never asks for your seed phrase.</p></>}>
      <h1 className="onb-h">Next: your private inbox.</h1>
      {bank && (
        <div className="notice notice-info onb-honest" role="note" data-testid="bank-honest">
          <strong>Bank statements are next</strong>
          <span>Today Notch reads MTN MoMo statements only. If you also have a MoMo wallet, use that one.</span>
        </div>
      )}
      <p className="onb-p">Your limit belongs to one wallet. Your wallet app opens and asks two things:</p>
      <div className="onb-stage wp" key={run} onClick={replay} aria-hidden="true">
        <div className="wp-phone">
          <div className="wp-sheet wp-a">
            <b>Connect</b>
            {['#AB9FF2', '#F5A524', '#3D7BF7'].map((c, i) => (
              <span key={c} className={cx('wp-row', i === 0 && 'hit')}><i style={{ background: c }} /><em /><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" pathLength={1} /></svg></span>
            ))}
          </div>
          <div className="wp-sheet wp-b">
            <b>Sign message</b>
            <em /><em style={{ width: '70%' }} /><em style={{ width: '82%' }} />
            <span className="wp-free">Moves no money</span>
            <span className="wp-sign">Sign</span>
            <span className="wp-seal"><svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: seal }} /></span>
          </div>
        </div>
      </div>
      <ol className="steps3 onb-steps">
        <li style={{ '--i': 0 } as React.CSSProperties}><span className="n">1</span><span><b>Connect</b><small className="eg">Pick your wallet from a list.</small></span></li>
        <li style={{ '--i': 1 } as React.CSSProperties}><span className="n">2</span><span><b>Sign one short message</b><small className="eg">It proves the inbox is yours. It costs nothing and moves no money.</small></span></li>
      </ol>
      {pollar?.step === 'authenticated' && (
        <div className="notice notice-info" role="status" style={{ marginTop: 16 }}>
          <strong>Signed in with Google</strong>
          <span>To get a limit and borrow, connect a self-custody wallet too. Google wallets can’t sign Notch’s steps yet.</span>
        </div>
      )}
    </Frame>
  );
}

// ---- a returning user, signed out: no questions again ---------------------------------------------------------------
export function WelcomeBack() {
  const { openSignIn, go } = useUi();
  const o = useOnboard();
  return (
    <section className="onb onb-promise" aria-labelledby="wb-h">
      <div className="brandpill glass lens">
        <svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="8" fill="#111A33" /><path d="M8.5 18V8.5l9 9V8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        notch
      </div>
      <Banners />
      <div className="onb-body">
        <h1 id="wb-h" className="onb-h">Welcome back.</h1>
        <p className="onb-p">{o.goal ? `Connect your wallet to see your limit for ${forGoal(o.goal)}.` : 'Connect your wallet to see your limit.'}</p>
      </div>
      <div className="onb-foot">
        <Btn onClick={openSignIn}>Connect wallet</Btn>
        <div className="onb-links"><button type="button" className="textlink" onClick={() => go('lend')}>I want to lend</button></div>
      </div>
    </section>
  );
}
