import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { LOAN_TERM_SECONDS, depositBorrowerIx, depositNeededFor, deriveLine, drawIx, feeFor, payoffFor } from './notch';
import { formatDate, formatUsdc, parseUsdc, toInput } from './amount';
import { stamp } from './art';
import { amountAtStamp, cellAt, normalizeAmount, stampUnit } from './amount-input';
import { buzz } from './glass';
import { ActionStatus, Btn, DoneView, Icon, Sheet, cx, useAction } from './ui';
import { Banners, useUi } from './App';
import { Nav } from './GetLimit';
import { FaucetButton } from './Faucet';
import { lineAfterPost, postIxsFor, unposted } from './post';
import { reportPosted } from './enclave';
import { Restoring, lineState, withAta } from './Home';
import { STEP, STEPS, forGoal, onboarding, setOnboard, useOnboard } from './onboard';

const MOTIFS = ['kente', 'sun', 'horn'] as const;

export function Borrow() {
  const { connected, signTransaction, restoring } = useWallet();
  const { line: chainLine, pool, usdc, addrs, refresh, patch, loading, session } = useChain();
  const { go, att } = useUi();
  const owner = connected?.address ?? null;
  // A signed limit not on Solana yet: price the loan as if it were posted, and post it in the same transaction.
  const pending = owner ? unposted(session.signed, chainLine) : null;
  const uwKey = att && att !== 'down' ? att.underwriter : null;
  const line = pending && owner ? lineAfterPost(pending, owner, chainLine) : chainLine;
  const s = lineState(line);
  const idle = pool?.stats.idle ?? 0n;
  const cap = s.headroom < idle ? s.headroom : idle;
  // First run: the amount starts at the whole limit they were just shown ("you can draw up to X"), said for their goal.
  const onb = useOnboard();
  const guided = onboarding(onb);
  // null = not touched yet: the first paint already shows the preset (no "Pay back 0.00" frame first).
  const [typed, setAmtStr] = useState<string | null>(null);
  const amtStr = typed ?? (s.live && pool ? toInput(guided || cap < 20_000_000n ? cap : 20_000_000n) : '');
  const [done, setDone] = useState<{ draw: bigint; payoff: bigint; due: bigint } | null>(null);

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

  const unit = useMemo(() => stampUnit(s.limit), [s.limit]);
  const count = Number((s.limit + unit - 1n) / unit);
  const usedN = Number((s.drawn + unit - 1n) / unit);
  const pickN = draw ? Number((draw + unit - 1n) / unit) : 0;
  const lastVal = s.limit - unit * BigInt(Math.max(0, count - 1));
  const stampSvgs = useMemo(() => Array.from({ length: count }, (_, i) => {
    const v = i === count - 1 ? lastVal : unit;
    const num = formatUsdc(v, { max: 2 }).replace(/\.00$/, '');
    return stamp(88, 104, { ink: 'verm', motif: MOTIFS[i % 3], num, cap: 'USDC', numSize: num.length > 3 ? 24 : 34, top: 'NOTCH' });
  }), [unit, count, lastVal]);

  const drawAct = useAction(refresh);

  // A short neutral note when the field changed what was typed (rounded or clamped). Fades after 2.5 s.
  const [note, setNote] = useState<{ text: string; k: number } | null>(null);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 2500); return () => clearTimeout(t); }, [note]);
  const amtRef = useRef<HTMLInputElement>(null);
  const overNote = (c: bigint) => cap < s.headroom ? `The pool has ${formatUsdc(c)} free right now` : s.drawn > 0n ? `You can borrow up to ${formatUsdc(c)} more` : `Your limit is ${formatUsdc(c)}`;
  const onType = (raw: string) => {
    const r = normalizeAmount(raw, cap, overNote);
    setAmtStr(r.text);
    if (r.note) setNote({ text: r.note, k: Date.now() });
  };

  const quick = [unit, unit * 2n, unit * 4n].filter((a) => a <= cap);

  // The stamp sheet is the slider: press and drag across the stamps in reading order. Full stamps before the finger
  // plus the share of the one under it (by how far across it the finger is), to the cent, snapping near stamp edges.
  // A touch that starts mostly vertical is left to the page so it still scrolls; a tap tears off up to a stamp.
  const gridEl = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; touch: boolean; on: boolean; r: DOMRect; last: bigint } | null>(null);
  const skipClick = useRef(false);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  // iOS Safari can still start a scroll mid-drag; once the drag is ours, its touchmoves are too.
  const stopScroll = useCallback((e: TouchEvent) => { if (drag.current?.on) e.preventDefault(); }, []);
  const gridRef = useCallback((el: HTMLDivElement | null) => {
    gridEl.current?.removeEventListener('touchmove', stopScroll);
    gridEl.current = el;
    el?.addEventListener('touchmove', stopScroll, { passive: false });
  }, [stopScroll]);
  const freeN = count - usedN;
  const setAmount = (v: bigint) => setAmtStr(toInput(v));
  const dragTo = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current!;
    const x = e.clientX - d.r.left, y = e.clientY - d.r.top;
    const c = cellAt(x, y, d.r.width, d.r.height, 4, count);
    const v = amountAtStamp(c.index - usedN, c.frac, unit, freeN, s.headroom, cap);
    if (v !== d.last) {
      if (v / unit !== d.last / unit) buzz(4);
      d.last = v;
      setAmount(v);
    }
    setBubble({ x: Math.min(d.r.width - 28, Math.max(28, x)), y: Math.max(0, Math.min(d.r.height, y)) });
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.on && !cancelled) skipClick.current = true;
    drag.current = null;
    setBubble(null);
  };
  const onSheetKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = draw ? (draw > cap ? cap : draw) : 0n;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 10_000n : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -10_000n : e.key === 'PageUp' ? unit : e.key === 'PageDown' ? -unit : null;
    let v: bigint;
    if (step !== null) v = cur + step;
    else if (e.key === 'Home') v = 0n;
    else if (e.key === 'End') v = cap;
    else return;
    e.preventDefault();
    v = v < 0n ? 0n : v > cap ? cap : v;
    if (v !== cur) { if (v / unit !== cur / unit) buzz(4); setAmount(v); }
  };
  // The last stamp torn off may be only partly used: show how much of it (a sliver at least, so 0.37 of 200 still shows).
  const partI = pickN ? usedN + pickN - 1 : -1;
  const partV = partI === count - 1 ? s.headroom - BigInt(pickN - 1) * unit : unit;
  const partF = draw && pickN ? Number(((draw - BigInt(pickN - 1) * unit) * 1000n) / partV) / 1000 : 1;

  // ONE approval: [post the limit] + [put down the 20% top-up] + borrow, in a single transaction (about 1.1 KB at
  // most, under Solana's 1232-byte cap). Only what is needed goes in: a draw that needs no top-up is just the draw.
  const onBorrow = () =>
    drawAct.run(async () => {
      if (!owner || !addrs || !draw) throw new Error('Enter how much to borrow.');
      if (pending && !uwKey) throw new Error('Could not read the sealed computer’s public key. Try again in a moment.');
      const { ata, ensure } = await withAta(addrs, owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const ixs = [
        ...(pending ? await postIxsFor(addrs, owner, pending, uwKey!) : []),
        ensure,
        ...(toAdd > 0n ? [depositBorrowerIx(addrs, owner, lineAddr, ata, toAdd)] : []),
        drawIx(addrs, owner, lineAddr, ata, draw),
      ];
      const { signature } = await sendTransaction(owner, ixs, signTransaction);
      if (pending) void reportPosted(signature);
      patch({ line: { drawn: (chainLine?.drawn ?? 0n) + draw, deposit: have + toAdd, ...(s.drawn === 0n ? { due: dueIfNow } : {}) }, usdc: usdc - toAdd + draw });
      setDone({ draw, payoff, due: dueIfNow });
      if (guided) setOnboard({ done: true, step: STEPS });
      return { signature, note: `${formatUsdc(draw)} USDC sent to your wallet.` };
    });

  const head = <><Nav title="Borrow" onBack={() => go('home')} progress={guided ? STEP.borrow : undefined} /><Banners /></>;
  if (!owner && restoring) return <>{head}<Restoring /></>;
  if (!owner) return <>{head}<Empty icon="wallet" title="Connect a wallet first" text="Borrowing uses your wallet’s limit." /></>;
  if (loading || (owner && !pool)) return <>{head}<div className="bamt"><label>Reading your line…</label><div className="v"><span className="skel" style={{ fontSize: 64 }}>00.00</span></div></div></>;
  if (!s.live) return <>{head}<Empty icon="mail" title={line?.defaulted ? 'This line is closed' : 'No limit yet'} text={line?.defaulted ? 'A payment was missed, so this wallet can’t borrow again.' : 'Get your limit first: it takes one statement.'} action={line?.defaulted ? undefined : { label: 'Get my limit', on: () => go('limit') }} /></>;
  if (s.pastDue) return <>{head}<Empty icon="clock" title="Your loan is overdue" text="Pay it back first. Then you can borrow again." action={{ label: 'Go to pay back', on: () => go('home') }} /></>;

  // After a borrow, only the receipt: the form behind it must not re-arm a second borrow.
  if (done) return (
    <>
      {head}
      <Sheet title="Sent" onClose={() => { setDone(null); go('home'); }}>
        <DoneView amount={`${formatUsdc(done.draw, { max: 2 })} USDC`} signature={drawAct.signature} onDone={() => { setDone(null); go('home'); }}
          text={<>is in your wallet. Pay back <b style={{ color: 'var(--ink)' }}>{formatUsdc(done.payoff, { up: true })}</b> by {formatDate(chainLine?.due && chainLine.due > 0n ? chainLine.due : done.due)}.</>} />
      </Sheet>
    </>
  );

  // Nothing left to borrow (whole limit used, or the pool is empty): say so instead of a dead 0 form.
  if (cap === 0n) return (
    <>{head}<Empty icon="check" title={s.headroom === 0n ? 'You’ve borrowed your whole limit' : 'The pool has no free USDC right now'}
      text={s.headroom === 0n ? `Pay back ${formatUsdc(payoffFor(s.drawn), { up: true })} USDC by ${formatDate(line!.due)} to borrow again.` : 'Lenders’ money is all lent out. Try again later.'}
      action={{ label: 'Go to Home', on: () => go('home') }} /></>
  );

  return (
    <div>
      {head}
      <div className="bamt">
        {guided && <p className="for-goal" data-testid="for-goal">For {forGoal(onb.goal)}</p>}
        <label htmlFor="amt">How much do you want to borrow? <span style={{ color: 'var(--faint)' }}>Up to {formatUsdc(cap)}</span></label>
        <div className="v" onClick={() => amtRef.current?.focus()}>
          <input ref={amtRef} id="amt" name="amount" inputMode="decimal" autoComplete="off" enterKeyHint="done" value={amtStr} onChange={(e) => onType(e.target.value)}
            onFocus={(e) => e.currentTarget.select()} aria-invalid={amtErr ? true : undefined} aria-describedby="amt-hint amt-err" />
          <span className="u">USDC</span>
        </div>
        <p className="amt-hint" id="amt-hint">Tap the amount to type any number</p>
        <p className={cx('amt-note', note && 'show')} aria-live="polite" data-testid="amt-note">{note?.text ?? ''}</p>
        {amtErr ? <p className="field-err" id="amt-err" role="alert">{amtErr}</p> : <div className="back">Pay back <b>{formatUsdc(payoff, { up: true })}</b> by {formatDate(dueIfNow)}</div>}
      </div>

      <div className="seg glass" role="group" aria-label="Quick amounts">
        {quick.map((a) => (
          <button key={String(a)} type="button" className={cx('tap', draw === a && 'on')} onClick={() => { setAmtStr(toInput(a)); buzz(4); }}>{formatUsdc(a).replace(/\.00$/, '')}</button>
        ))}
        <button type="button" className={cx('tap', draw === cap && 'on')} onClick={() => { setAmtStr(toInput(cap)); buzz(4); }} disabled={cap === 0n}>All</button>
      </div>

      <div className="sheetwrap">
        <div className="selv" aria-hidden="true"><span>Notch · {formatUsdc(unit).replace(/\.00$/, '')} USDC each</span><span>{formatUsdc(draw && draw > 0n ? draw : 0n, { max: 2 })} of {formatUsdc(s.headroom, { max: 2 })} free</span></div>
        <div ref={gridRef} className={cx('sgrid', bubble && 'drag')} role="slider" tabIndex={0} aria-label="Amount to borrow" data-testid="stamp-slider"
          aria-valuemin={0} aria-valuemax={Number(toInput(cap))} aria-valuenow={Number(toInput(draw && draw > 0n ? draw : 0n))}
          aria-valuetext={`${formatUsdc(draw && draw > 0n ? draw : 0n, { max: 2 })} USDC`}
          onKeyDown={onSheetKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            skipClick.current = false;
            drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, touch: e.pointerType === 'touch', on: false, r: e.currentTarget.getBoundingClientRect(), last: draw && draw > 0n ? draw : 0n };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            if (!d.on) {
              const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
              if (Math.hypot(dx, dy) < (d.touch ? 8 : 4)) return;
              if (d.touch && Math.abs(dy) > Math.abs(dx)) { drag.current = null; return; } // a scroll, not a drag
              d.on = true;
              e.currentTarget.setPointerCapture(e.pointerId);
            }
            dragTo(e);
          }}
          onPointerUp={(e) => endDrag(e, false)} onPointerCancel={(e) => endDrag(e, true)}
          onClickCapture={(e) => { if (skipClick.current) { skipClick.current = false; e.stopPropagation(); e.preventDefault(); } }}>
          {Array.from({ length: count }, (_, i) => (
            <button key={i} type="button" tabIndex={-1} aria-hidden="true" className={cx(i < usedN && 'gone', i >= usedN && i < usedN + pickN && 'pick', i === partI && partF < 1 && 'part')} disabled={i < usedN}
              style={i === partI && partF < 1 ? { '--f': `${Math.max(14, Math.round(partF * 100))}%` } as CSSProperties : undefined}
              onClick={() => { const a = i === count - 1 ? s.headroom : BigInt(i - usedN + 1) * unit; setAmtStr(toInput(a < cap ? a : cap)); buzz(4); }}>
              <svg viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: stampSvgs[i] }} />
            </button>
          ))}
          {bubble && <span className="sbub" aria-hidden="true" style={{ transform: `translate(${bubble.x}px, ${bubble.y}px)` }}><span>{formatUsdc(draw && draw > 0n ? draw : 0n, { max: 2 })}</span></span>}
        </div>
        <div className="selvb" aria-hidden="true">Drag across the stamps, or tap the amount to type it</div>
      </div>

      <div className="rcpt pcard" aria-label="What this costs">
        <div className="r"><span>Deposit needed, 20%<small>Of all you owe. Comes back when you pay.</small></span><b data-testid="dep-needed">{formatUsdc(needed, { up: true })}</b></div>
        <div className="r"><span>Already held</span><b>{formatUsdc(have)}</b></div>
        <div className="r total"><span>Add now</span><b data-testid="dep-add">{formatUsdc(toAdd, { up: true })}</b></div>
        <div className="r"><span>Fee, 2%<small>Paid when you pay back</small></span><b>{formatUsdc(fee, { up: true })}</b></div>
      </div>

      {okAmount && usdc >= toAdd && <p className="help one-tx" data-testid="one-tx">
        One approval{pending ? ': posts your limit, ' : ': '}{toAdd > 0n ? <>puts down <b>{formatUsdc(toAdd, { up: true })}</b> and </> : ''}sends you <b>{formatUsdc(draw!)}</b>.
      </p>}

      <div className="dock">
        {okAmount && usdc < toAdd ? (
          <div className="dock-warn glass"><p className="help warn">Your wallet has {formatUsdc(usdc)} test USDC. The deposit needs {formatUsdc(toAdd - usdc, { up: true })} more.</p><FaucetButton /></div>
        ) : (
          <>
            <Slide label={okAmount ? `Slide to borrow ${formatUsdc(draw!)}` : 'Pick an amount'} aria={okAmount ? `Borrow ${formatUsdc(draw!)} USDC` : 'Borrow'} disabled={!okAmount || drawAct.busy} busy={drawAct.busy} onDone={onBorrow} />
          </>
        )}
      </div>
      <div className="pad"><ActionStatus a={drawAct} /></div>

    </div>
  );
}

function Empty({ icon, title, text, action }: { icon: 'wallet' | 'mail' | 'clock' | 'check'; title: string; text: string; action?: { label: string; on: () => void } }) {
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
