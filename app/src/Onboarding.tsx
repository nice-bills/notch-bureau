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

/** The progress bar: always the same ten steps, from the promise to the first loan. */
export function Progress({ at }: { at: number }) {
  const pct = Math.round(((at + 1) / STEPS) * 100);
  return (
    <div className="onb-bar" role="progressbar" aria-label="Getting started" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={at + 1} aria-valuetext={`Step ${at + 1} of ${STEPS}`}>
      <i style={{ transform: `scaleX(${pct / 100})` }} />
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

  switch (step) {
    case STEP.promise: return <Pitch />;
    case STEP.goal: return <Choose step={step} title="What’s the money for?" sub="Pick one. We set things up around it." options={GOALS.map((g) => ({ ...g, sub: undefined }))} value={o.goal} onPick={(g) => setOnboard({ goal: g as Goal })} />;
    case STEP.paid: return <Choose step={step} title="How does your money come in?" sub="So we ask for the right statement." options={PAID} value={o.paid} onPick={(p) => setOnboard({ paid: p as Paid })} />;
    case STEP.private: return <Private goal={o.goal} />;
    case STEP.costs: return <Costs goal={o.goal} />;
    default: return <Prime paid={o.paid} />;
  }
}

function Frame({ step, children, foot, label }: { step: number; children: ReactNode; foot?: ReactNode; label: string }) {
  return (
    <section className="onb" aria-label={label} data-step={step}>
      <div className="onb-top">
        <button type="button" className="circ glass lens tap" onClick={() => backStep(step)} aria-label="Back" data-onb-back><Icon name="back" /></button>
        <Progress at={step} />
      </div>
      <div className="onb-body">{children}</div>
      {foot && <div className="onb-foot">{foot}</div>}
    </section>
  );
}

// ---- 0. the promise: the original welcome (envelope + stamp wall) -------------------------------------------------
const WALL: [Ink, Motif, string][] = [['verm', 'sun', '5'], ['ultra', 'bank', '10'], ['ochre', 'kente', '20'], ['sea', 'waves', '2'], ['verm', 'horn', '1'], ['ultra', 'waves', '50'], ['ochre', 'sun', '5'], ['sea', 'kente', '10']];
const CAPS = ['GHANA', 'NOTCH', 'AIRMAIL', 'ACCRA', 'POSTE', 'KUMASI', 'TAMALE', 'CEDI'];

function Pitch() {
  const { openSignIn, go } = useUi();
  const wall = useMemo(() => {
    let html = '';
    for (let r = 0; r < 3; r++) {
      html += '<div class="row">';
      for (let i = 0; i < 9; i++) {
        const [ink, mo, num] = WALL[(i * 3 + r * 5) % WALL.length];
        html += `<svg viewBox="0 0 88 104">${stamp(88, 104, { ink, motif: mo, num, cap: CAPS[(i + r * 2) % CAPS.length] })}</svg>`;
      }
      html += '</div>';
    }
    return html;
  }, []);
  const env = useMemo(() => envelope(), []);
  const mark = useMemo(() => stamp(88, 104, { ink: 'verm', motif: 'kente', num: '120', cap: 'USDC', top: 'NOTCH', numSize: 30 }), []);
  // Interactive hero: the envelope leans toward the finger (the stamp wall drifts the other way), and a tap stamps an
  // example limit on it. Plain CSS variables, no re-render per move.
  const root = useRef<HTMLElement>(null);
  const [stamped, setStamped] = useState(false);
  const lean = (e: React.PointerEvent) => {
    const el = root.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    el.style.setProperty('--lx', x.toFixed(3));
    el.style.setProperty('--ly', y.toFixed(3));
  };
  const settle = () => { root.current?.style.setProperty('--lx', '0'); root.current?.style.setProperty('--ly', '0'); };
  const press = () => { setStamped((v) => !v); buzz(stamped ? 6 : 18); };
  return (
    <section ref={root} className={cx('welcome', 'welcome-live', stamped && 'is-stamped')} aria-labelledby="p-h" data-step={0} onPointerMove={lean} onPointerLeave={settle} onPointerUp={(e) => { if (e.pointerType !== 'mouse') settle(); }}>
      <div className="brandpill glass lens">
        <svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="8" fill="#111A33" /><path d="M8.5 18V8.5l9 9V8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        notch
      </div>
      <Banners />
      <div className="lede">
        <h1 id="p-h">Credit from the money history you already have.</h1>
        <p>No bank account, no credit score, no land or car to pledge. Your money statement is the proof.</p>
      </div>
      <button type="button" className="hero" onClick={press} aria-pressed={stamped} aria-label={stamped ? 'Example limit stamped. Tap to clear.' : 'Tap the envelope to see an example limit'}>
        <svg viewBox="0 0 312 204" aria-hidden="true" dangerouslySetInnerHTML={{ __html: env }} />
        <span className="hero-mark" aria-hidden="true"><svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: mark }} /></span>
      </button>
      <p className="hero-hint" aria-live="polite">{stamped ? '120 USDC to borrow (example). Yours comes from your statement.' : 'Tap the envelope'}</p>
      <div className="wall" aria-hidden="true"><div className="rows" dangerouslySetInnerHTML={{ __html: wall }} /></div>
      <div className="foot">
        <Btn onClick={() => goStep(STEP.goal)}>Get started</Btn>
        <div className="onb-links">
          <button type="button" className="textlink" onClick={openSignIn}>I already use Notch</button>
          <button type="button" className="textlink" onClick={() => go('lend')}>I want to lend</button>
        </div>
      </div>
    </section>
  );
}

// ---- 1, 2. one question, tap to answer -----------------------------------------------------------------------------
type Opt = { id: string; label: string; sub?: string; icon: Parameters<typeof Icon>[0]['name'] };
function Choose({ step, title, sub, options, value, onPick }: { step: number; title: string; sub: string; options: Opt[]; value?: string; onPick: (id: string) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (id: string) => {
    onPick(id);
    buzz(8);
    clearTimeout(timer.current);
    // a beat to see the tick, then on to the next screen
    timer.current = setTimeout(() => { if (getOnboard().step === step) goStep(step + 1); }, 240);
  };
  return (
    <Frame step={step} label={title}>
      <h1 className="onb-h">{title}</h1>
      <p className="onb-p">{sub}</p>
      <div className="choices" role="radiogroup" aria-label={title}>
        {options.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={value === x.id} className={cx('choice tap', value === x.id && 'on')} onClick={() => pick(x.id)}>
            <span className="choice-ico"><Icon name={x.icon} /></span>
            <span className="t"><b>{x.label}</b>{x.sub && <small>{x.sub}</small>}</span>
            <span className="choice-ck" aria-hidden="true"><Icon name="check" /></span>
          </button>
        ))}
      </div>
    </Frame>
  );
}

// ---- 3. belief: it stays private (true facts only) -----------------------------------------------------------------
function Private({ goal }: { goal?: Goal }) {
  const what = 'statement';
  return (
    <Frame step={STEP.private} label="Your statement stays private" foot={<Btn onClick={() => goStep(STEP.costs)}>Next</Btn>}>
      <p className="onb-eyebrow">For {forGoal(goal)}</p>
      <h1 className="onb-h">Your {what} stays private.</h1>
      <ul className="facts onb-facts">
        <li className="fact"><Icon name="lock" /><span><b>Read inside sealed hardware</b><small>Your transaction history is read there. Nobody can look inside, not even us.</small></span></li>
        <li className="fact"><Icon name="shield" /><span><b>Only one number leaves</b><small>Your limit. Not your name, not your payments.</small></span></li>
        <li className="fact"><Icon name="check" /><span><b>Nothing is kept</b><small>The {what} is deleted once it is read.</small></span></li>
      </ul>
    </Frame>
  );
}

// ---- 4. belief: the cost, before anything is asked -----------------------------------------------------------------
const EG = 50_000_000n;
function Costs({ goal }: { goal?: Goal }) {
  const dep = depositNeededFor(EG), fee = feeFor(EG), pay = payoffFor(EG);
  const f = (v: bigint) => formatUsdc(v).replace(/\.00$/, '');
  return (
    <Frame step={STEP.costs} label="What it costs" foot={<Btn onClick={() => goStep(STEP.prime)}>Next</Btn>}>
      <p className="onb-eyebrow">For {forGoal(goal)}</p>
      <h1 className="onb-h">The cost, up front.</h1>
      <p className="onb-p">Say you borrow {f(EG)} USDC:</p>
      <div className="rcpt pcard onb-rcpt" data-testid="cost-example">
        <div className="r"><span>You put down, 20%<small>Comes back when you pay</small></span><b>{f(dep)}</b></div>
        <div className="r"><span>Fee, 2%</span><b>{f(fee)}</b></div>
        <div className="r total"><span>You pay back</span><b>{f(pay)}</b></div>
        <div className="r"><span>Deposit back</span><b style={{ color: 'var(--green)' }}>+{f(dep)}</b></div>
      </div>
      <p className="help onb-note"><Icon name="clock" />Your limit lasts 30 days. Pay back within 30 days.</p>
    </Frame>
  );
}

// ---- 5. the wallet, primed: why, and what will pop up --------------------------------------------------------------
function Prime({ paid }: { paid?: Paid }) {
  const { openSignIn, pollar } = useUi();
  const bank = paid === 'bank';
  return (
    <Frame step={STEP.prime} label="Connect your wallet" foot={<><Btn onClick={openSignIn}>Connect wallet</Btn><p className="help" style={{ textAlign: 'center', margin: '4px 0 0' }}>Notch never asks for your seed phrase.</p></>}>
      <h1 className="onb-h">Next: your private inbox.</h1>
      {bank && (
        <div className="notice notice-info onb-honest" role="note" data-testid="bank-honest">
          <strong>Bank statements are next</strong>
          <span>Today Notch reads MTN MoMo statements only. If you also have a MoMo wallet, use that one.</span>
        </div>
      )}
      <p className="onb-p">Your limit belongs to one wallet. Your wallet app opens and asks two things:</p>
      <ol className="steps3 onb-steps">
        <li><span className="n">1</span><span><b>Connect</b><small className="eg">Pick your wallet from a list.</small></span></li>
        <li><span className="n">2</span><span><b>Sign one short message</b><small className="eg">It proves the inbox is yours. It costs nothing and moves no money.</small></span></li>
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
