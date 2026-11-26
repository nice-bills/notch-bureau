import { useEffect, useMemo, useRef, useState } from 'react';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { LOAN_TERM_SECONDS, depositBorrowerIx, depositNeededFor, deriveLine, drawIx, feeFor, payoffFor } from './notch';
import { formatDate, formatUsdc, parseUsdc, toInput } from './amount';
import { stamp } from './art';
import { buzz } from './glass';
import { ActionStatus, Btn, Icon, Sheet, cx, useAction } from './ui';
import { Banners, useUi } from './App';
import { Nav } from './GetLimit';
import { FaucetButton } from './Faucet';
import { lineState, withAta } from './Home';

const UNITS = [1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n, 1000n, 5000n].map((u) => u * 1_000_000n);
const MOTIFS = ['kente', 'sun', 'horn'] as const;

export function Borrow() {
  const { connected, signTransaction } = useWallet();
  const { line, pool, usdc, addrs, refresh, patch, loading } = useChain();
  const { go } = useUi();
  const owner = connected?.address ?? null;
  const s = lineState(line);
  const idle = pool?.stats.idle ?? 0n;
  const cap = s.headroom < idle ? s.headroom : idle;
  const [amtStr, setAmtStr] = useState('');
  const [done, setDone] = useState<{ draw: bigint; payoff: bigint; due: bigint } | null>(null);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !s.live || !pool) return;
    seeded.current = true;
    const start = cap > 20_000_000n ? 20_000_000n : cap;
    setAmtStr(toInput(start));
  }, [s.live, pool, cap]);

  const draw = parseUsdc(amtStr);
  const totalAfter = s.drawn + (draw ?? 0n);
  const needed = draw ? depositNeededFor(totalAfter) : 0n;
  const have = s.deposit;
  const toAdd = needed > have ? needed - have : 0n;
  const fee = feeFor(totalAfter);
  const payoff = payoffFor(totalAfter);
  const dueIfNow = BigInt(Math.floor(Date.now() / 1000)) + LOAN_TERM_SECONDS;
  const amtErr = amtStr && draw === null ? 'Enter a number like 25 or 12.5' : draw && draw > s.headroom ? `Your limit leaves ${formatUsdc(s.headroom)} USDC.` : draw && draw > idle ? `The pool only has ${formatUsdc(idle)} USDC free right now.` : null;
  const okAmount = !!draw && draw > 0n && !amtErr;

  const unit = useMemo(() => UNITS.find((u) => (s.limit + u - 1n) / u <= 12n) ?? UNITS[UNITS.length - 1], [s.limit]);
  const count = Number((s.limit + unit - 1n) / unit);
  const usedN = Number((s.drawn + unit - 1n) / unit);
  const pickN = draw ? Number((draw + unit - 1n) / unit) : 0;
  const stampSvgs = useMemo(() => MOTIFS.map((m) => stamp(88, 104, { ink: 'verm', motif: m, num: formatUsdc(unit).replace(/\.00$/, ''), cap: 'USDC', numSize: 34, top: 'NOTCH' })), [unit]);

  const depAct = useAction(refresh);
  const drawAct = useAction(refresh);

  const onDeposit = () =>
    depAct.run(async () => {
      if (!owner || !addrs) throw new Error('Connect a wallet first.');
      if (!toAdd) throw new Error('No deposit is needed for this amount.');
      const { ata, ensure } = await withAta(addrs, owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, depositBorrowerIx(addrs, owner, lineAddr, ata, toAdd)], signTransaction);
      patch({ line: { deposit: have + toAdd }, usdc: usdc - toAdd });
      return { signature, note: `Deposit added: ${formatUsdc(toAdd)} USDC.` };
    });

  const onDraw = () =>
    drawAct.run(async () => {
      if (!owner || !addrs || !draw) throw new Error('Enter how much to borrow.');
      const { ata, ensure } = await withAta(addrs, owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, drawIx(addrs, owner, lineAddr, ata, draw)], signTransaction);
      patch({ line: { drawn: (line?.drawn ?? 0n) + draw, ...(line && line.drawn === 0n ? { due: dueIfNow } : {}) }, usdc: usdc + draw });
      setDone({ draw, payoff, due: dueIfNow });
      return { signature, note: `${formatUsdc(draw)} USDC sent to your wallet.` };
    });

  const head = <><Nav title="Borrow" onBack={() => go('home')} /><Banners /></>;
  if (!owner) return <>{head}<Empty icon="wallet" title="Connect a wallet first" text="Borrowing uses your wallet’s limit." /></>;
  if (loading) return <>{head}<div className="bamt"><label>Reading your line…</label><div className="v"><span className="skel" style={{ fontSize: 64 }}>00.00</span></div></div></>;
  if (!s.live) return <>{head}<Empty icon="mail" title={line?.defaulted ? 'This line is closed' : 'No limit yet'} text={line?.defaulted ? 'A payment was missed, so this wallet can’t borrow again.' : 'Get your limit first: it takes one statement.'} action={line?.defaulted ? undefined : { label: 'Get my limit', on: () => go('limit') }} /></>;
  if (s.pastDue) return <>{head}<Empty icon="clock" title="Your loan is overdue" text="Pay it back first. Then you can borrow again." action={{ label: 'Go to pay back', on: () => go('home') }} /></>;

  const step = toAdd > 0n ? 1 : 2;
  return (
    <div>
      {head}
      <div className="bamt">
        <label htmlFor="amt">How much do you want to borrow? <span style={{ color: 'var(--faint)' }}>Up to {formatUsdc(cap)}</span></label>
        <div className="v">
          <input id="amt" name="amount" inputMode="decimal" autoComplete="off" value={amtStr} onChange={(e) => setAmtStr(e.target.value)} aria-invalid={amtErr ? true : undefined} aria-describedby="amt-err" />
          <span className="u">USDC</span>
        </div>
        {amtErr ? <p className="field-err" id="amt-err" role="alert">{amtErr}</p> : <div className="back">Pay back <b>{formatUsdc(payoff)}</b> by {formatDate(dueIfNow)}</div>}
      </div>

      <div className="seg glass" role="group" aria-label="Quick amounts">
        {[unit, unit * 2n, unit * 4n].filter((a) => a <= cap).map((a) => (
          <button key={String(a)} type="button" className={cx('tap', draw === a && 'on')} onClick={() => { setAmtStr(toInput(a)); buzz(4); }}>{formatUsdc(a).replace(/\.00$/, '')}</button>
        ))}
        <button type="button" className={cx('tap', draw === cap && 'on')} onClick={() => { setAmtStr(toInput(cap)); buzz(4); }} disabled={cap === 0n}>All</button>
      </div>

      <div className="sheetwrap" aria-hidden="true">
        <div className="selv"><span>Notch · {formatUsdc(unit).replace(/\.00$/, '')} USDC each</span><span>{Math.min(pickN, count - usedN)} of {count - usedN} left</span></div>
        <div className="sgrid">
          {Array.from({ length: count }, (_, i) => (
            <button key={i} type="button" tabIndex={-1} className={cx(i < usedN && 'gone', i >= usedN && i < usedN + pickN && 'pick')} disabled={i < usedN}
              onClick={() => { const a = BigInt(i - usedN + 1) * unit; setAmtStr(toInput(a < cap ? a : cap)); buzz(4); }}>
              <svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: stampSvgs[i % 3] }} />
            </button>
          ))}
        </div>
        <div className="selvb">Tap a stamp to tear off up to it</div>
      </div>

      <div className="rcpt pcard" aria-label="What this costs">
        <div className="r"><span>Deposit needed, 20%<small>Of all you owe. Comes back when you pay.</small></span><b data-testid="dep-needed">{formatUsdc(needed)}</b></div>
        <div className="r"><span>Already held</span><b>{formatUsdc(have)}</b></div>
        <div className="r total"><span>Add now</span><b data-testid="dep-add">{formatUsdc(toAdd)}</b></div>
        <div className="r"><span>Fee, 2%<small>Paid when you pay back</small></span><b>{formatUsdc(fee)}</b></div>
      </div>

      <div className="stepper" aria-label="Steps">
        <div className={step === 1 ? 'on' : 'ok'}><i>{step === 1 ? 1 : '✓'}</i>Put down 20%</div>
        <div className={step === 2 ? 'on' : ''}><i>2</i>Borrow</div>
      </div>

      <div className="dock">
        {step === 1 ? (
          <>
            <Btn onClick={onDeposit} busy={depAct.busy} disabled={!okAmount || usdc < toAdd}>Add {formatUsdc(toAdd)} USDC deposit</Btn>
            {okAmount && usdc < toAdd && <><p className="help warn" style={{ textAlign: 'center' }}>Your wallet has {formatUsdc(usdc)} test USDC. You need {formatUsdc(toAdd - usdc)} more.</p><div style={{ display: 'flex', justifyContent: 'center' }}><FaucetButton /></div></>}
          </>
        ) : (
          <Slide label={okAmount ? `Slide to borrow ${formatUsdc(draw!)}` : 'Pick an amount'} aria={okAmount ? `Borrow ${formatUsdc(draw!)} USDC` : 'Borrow'} disabled={!okAmount || drawAct.busy} busy={drawAct.busy} onDone={onDraw} />
        )}
      </div>
      <div className="pad"><ActionStatus a={depAct} /><ActionStatus a={drawAct} /></div>

      {done && (
        <Sheet title="Sent" onClose={() => { setDone(null); go('home'); }}>
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <div className="done-amt">{formatUsdc(done.draw, { max: 2 })} USDC</div>
            <p className="sh-p">is in your wallet. Pay back <b style={{ color: 'var(--ink)' }}>{formatUsdc(done.payoff, { max: 2 })}</b> by {formatDate(line?.due && line.due > 0n ? line.due : done.due)}.</p>
          </div>
          <Btn onClick={() => { setDone(null); go('home'); }}>Done</Btn>
        </Sheet>
      )}
    </div>
  );
}

function Empty({ icon, title, text, action }: { icon: 'wallet' | 'mail' | 'clock'; title: string; text: string; action?: { label: string; on: () => void } }) {
  return (
    <div className="card pcard empty">
      <div className="ico"><Icon name={icon} /></div>
      <b>{title}</b>
      <p>{text}</p>
      {action && <div style={{ marginTop: 16 }}><Btn onClick={action.on}>{action.label}</Btn></div>}
    </div>
  );
}

/** Slide to confirm. Drag the knob all the way, or press Enter/Space on it. */
function Slide({ label, aria, disabled, busy, onDone }: { label: string; aria: string; disabled: boolean; busy: boolean; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLButtonElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const st = useRef<{ x0: number; max: number; x: number; w: number } | null>(null);
  const rubber = (x: number, d = 60, c = 0.55) => (x * d * c) / (d + c * Math.abs(x));
  const put = (x: number, anim: boolean) => {
    const k = knob.current, f = fill.current, b = box.current;
    if (!k || !f || !b) return;
    // Writes only (the width is measured once on press): no forced layout while the finger moves.
    const w = st.current?.w ?? b.offsetWidth;
    k.style.transition = anim ? 'transform .25s var(--spring)' : 'none';
    f.style.transition = anim ? 'transform .22s var(--ease-out)' : 'none';
    k.style.transform = x ? `translateX(${x}px)` : '';
    f.style.transform = `scaleX(${x ? Math.max(0, (x + 60) / w) : 0})`;
  };
  useEffect(() => { if (!busy) put(0, true); }, [busy]);
  return (
    <div ref={box} className={cx('swipe glass lens', disabled && 'off')}>
      <div className="fillr" ref={fill} />
      <div className="lbl"><span className={disabled ? '' : 'shimmer'}>{busy ? 'Sending…' : label}</span></div>
      <button ref={knob} type="button" className="knob glass tint" aria-label={aria} disabled={disabled}
        onPointerDown={(e) => { if (disabled) return; const b = box.current!; st.current = { x0: e.clientX, max: b.offsetWidth - 64, x: 0, w: b.offsetWidth }; knob.current!.setPointerCapture(e.pointerId); buzz(4); }}
        onPointerMove={(e) => { const s = st.current; if (!s) return; const raw = e.clientX - s.x0; s.x = raw < 0 ? rubber(raw) : raw > s.max ? s.max + rubber(raw - s.max) : raw; put(s.x, false); }}
        onPointerUp={() => { const s = st.current; st.current = null; if (!s) return; if (s.x > s.max * 0.86) { put(s.max, false); buzz(24); onDone(); } else put(0, true); }}
        onPointerCancel={() => { st.current = null; put(0, true); }}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); onDone(); } }}
        onClick={(e) => { e.preventDefault(); if (e.detail === 0 && !disabled) onDone(); }}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="next" />}
      </button>
    </div>
  );
}
