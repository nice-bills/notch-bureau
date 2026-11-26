import { useEffect, useMemo, useState } from 'react';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import {
  CLAIM_WINDOW_SECONDS,
  WITHDRAW_COOLDOWN_SECONDS,
  cancelWithdrawIx,
  claimWithdrawIx,
  createAtaIdempotentIx,
  depositIx,
  deriveAta,
  deriveEscrow,
  deriveWithdrawRequest,
  requestWithdrawIx,
  seniorHeadroom,
  sharesForDeposit,
  splitLoss,
  trancheMint,
  trancheNav,
  usdcForShares,
  type Tranche,
  type WithdrawRequest,
} from './notch';
import { formatDateTime, formatUsdc, parseUsdc, toInput } from './amount';
import { ActionStatus, Btn, Field, Icon, Money, Sheet, Skel, cx, useAction } from './ui';
import { Banners, useUi } from './App';
import { Avatar } from './Home';
import type { PoolView } from './chain';

export const NAME: Record<Tranche, string> = { senior: 'Safe', junior: 'Risky' };
const MIN_FIRST_DEPOSIT = 1_000_000n;

/** Seconds left as 'Dd HH:MM:SS' / 'HH:MM:SS'. */
export function formatCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const hms = [Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return d > 0 ? `${d}d ${hms}` : hms;
}

function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export const supplyOf = (p: PoolView, t: Tranche) => (t === 'senior' ? p.seniorSupply : p.juniorSupply);
/** Price of one share (6 decimals) as text; 1.000000 before any shares exist. */
export function sharePrice(p: PoolView, t: Tranche): string {
  const nav = trancheNav(p.stats, t), supply = supplyOf(p, t);
  if (supply === 0n || nav === 0n) return '1.000000';
  const scaled = (nav * 1_000_000n) / supply;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, '0')}`;
}
/** What a pending request pays at claim: the lower of the request-time and claim-time price (the program's rule). */
export function claimValue(p: PoolView, t: Tranche, r: WithdrawRequest): bigint {
  const now = usdcForShares(r.shares, supplyOf(p, t), trancheNav(p.stats, t));
  if (r.supplyAtRequest === 0n) return now;
  const then = (r.shares * r.navAtRequest) / r.supplyAtRequest;
  return then < now ? then : now;
}

export function Lend() {
  const { connected } = useWallet();
  const { pool, shares, requests, loading, poolLoaded } = useChain();
  const { openSignIn } = useUi();
  const owner = connected?.address ?? null;
  const now = useNowSeconds();
  const [sel, setSel] = useState<Tranche>('senior');
  const [sheet, setSheet] = useState<'deposit' | 'withdraw' | null>(null);
  const [loss, setLoss] = useState(false);

  const value = (t: Tranche) => {
    if (!pool) return 0n;
    const pend = requests[t]?.shares ?? 0n;
    return usdcForShares(shares[t] + pend, supplyOf(pool, t), trancheNav(pool.stats, t));
  };
  const total = value('senior') + value('junior');
  const s = pool?.stats;
  const navTotal = s ? s.seniorNav + s.juniorNav : 0n;
  const pct = (t: Tranche) => (navTotal === 0n || !s ? 0 : Number((trancheNav(s, t) * 1000n) / navTotal) / 10);
  const hit = useMemo(() => {
    if (!s || navTotal === 0n) return { s: 0, j: 0 };
    const l = navTotal / 20n; // a 5% loss
    const [ls, lj] = splitLoss(l, s.seniorNav, s.juniorNav);
    return { s: s.seniorNav ? Number((ls * 1000n) / s.seniorNav) / 10 : 0, j: s.juniorNav ? Number((lj * 1000n) / s.juniorNav) / 10 : 0 };
  }, [s, navTotal]);
  const busyRead = owner ? loading || !poolLoaded : !poolLoaded;

  return (
    <div className="lend">
      <div className="ahead">
        <div><small>Lend USDC to everyday earners</small><h1>Lend</h1></div>
        <Avatar />
      </div>
      <Banners />
      <div className="balcard pcard">
        <small>{owner ? 'You have lent' : 'Cash ready to lend in the pool'}</small>
        <div className="amt" data-testid="lent-total"><Skel loading={busyRead}><Money v={formatUsdc(owner ? total : s?.idle ?? 0n, { max: 2 })} /></Skel><span className="u">USDC</span></div>
        {!owner && <p className="help">Connect a wallet to lend. Every borrower puts down 20% first, and pays a flat 2% fee.</p>}
      </div>

      <div className="trs" role="radiogroup" aria-label="Pick a share of the pool">
        {(['senior', 'junior'] as Tranche[]).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={sel === t} className={cx('trc tap', t === 'senior' ? 'safe' : 'risky', sel === t && 'sel')} onClick={() => setSel(t)}>
            <span className="bar" aria-hidden="true"><i style={{ height: `${pct(t)}%` }} /></span>
            <b className="n">{NAME[t]}</b>
            <span className="rate">{t === 'senior' ? 'Paid first, smaller fee share' : 'Hurt first, bigger fee share'}</span>
            <span className="rate">1 share = {pool ? sharePrice(pool, t) : '…'}</span>
            <span className="yours"><small>{owner ? 'Yours' : 'In this share'}</small><b data-testid={`yours-${t}`}><Skel loading={busyRead}>{formatUsdc(owner ? value(t) : s ? trancheNav(s, t) : 0n, { max: 2 })}</Skel></b></span>
          </button>
        ))}
      </div>

      <div className="acts">
        <Btn onClick={() => (owner ? setSheet('deposit') : openSignIn())}><Icon name="plus" />Add to {NAME[sel]}</Btn>
        <Btn variant="secondary" onClick={() => (owner ? setSheet('withdraw') : openSignIn())}>Withdraw</Btn>
      </div>
      {owner && (['senior', 'junior'] as Tranche[]).map((t) => requests[t] && pool && <Pending key={t} t={t} r={requests[t]!} pool={pool} now={now} />)}

      <section className="card pcard" aria-labelledby="loss-h">
        <h3 id="loss-h">What if someone doesn’t pay?</h3>
        <p className="sub">Their 20% deposit goes to lenders first. Any loss left hits Risky. Safe is hurt only after Risky is gone.</p>
        <div className="stackv">
          <div className="s">Safe · {pct('senior').toFixed(1)}%<span className="hit" style={{ width: loss ? `${Math.min(100, hit.s)}%` : 0 }} /></div>
          <div className="k">Risky · {pct('junior').toFixed(1)}%<span className="hit" style={{ width: loss ? `${Math.min(100, hit.j)}%` : 0 }} /></div>
        </div>
        <button type="button" className="chip tap" style={{ marginTop: 16, width: '100%', justifyContent: 'center' }} onClick={() => setLoss((v) => !v)} aria-pressed={loss} disabled={navTotal === 0n}>
          {loss ? `A 5% loss: Risky loses ${hit.j.toFixed(1)}%, Safe ${hit.s.toFixed(1)}%` : 'Show a 5% loss'}
        </button>
      </section>

      {sheet === 'deposit' && <DepositSheet t={sel} onClose={() => setSheet(null)} />}
      {sheet === 'withdraw' && <WithdrawSheet t={sel} onClose={() => setSheet(null)} />}
    </div>
  );
}

function DepositSheet({ t, onClose }: { t: Tranche; onClose: () => void }) {
  const { connected, signTransaction } = useWallet();
  const { addrs, pool, usdc, refresh } = useChain();
  const owner = connected!.address;
  const [str, setStr] = useState('');
  const dep = parseUsdc(str);
  const act = useAction(async () => { await refresh(); });
  const supply = pool ? supplyOf(pool, t) : 0n;
  const nav = pool ? trancheNav(pool.stats, t) : 0n;
  const sharesOut = dep && pool ? sharesForDeposit(dep, supply, nav) : 0n;
  const room = t === 'senior' && pool ? seniorHeadroom(pool.stats) : null;
  const err = str && dep === null ? 'Enter a number like 100 or 12.5'
    : dep && dep > usdc ? `Your wallet only holds ${formatUsdc(usdc)} USDC.`
    : dep && room !== null && dep > room ? `Safe can take ${formatUsdc(room)} USDC right now. Safe money needs enough Risky money underneath it.`
    : dep && supply === 0n && dep < MIN_FIRST_DEPOSIT ? 'The first deposit into an empty share must be at least 1 USDC.'
    : null;

  const onDeposit = () =>
    act.run(async () => {
      if (!addrs || !dep) throw new Error('Enter an amount.');
      const mint = trancheMint(addrs, t);
      const usdcAta = await deriveAta(owner, addrs.mint);
      const shareAta = await deriveAta(owner, mint);
      const { signature } = await sendTransaction(owner, [
        createAtaIdempotentIx(owner, usdcAta, owner, addrs.mint),
        createAtaIdempotentIx(owner, shareAta, owner, mint),
        depositIx(addrs, owner, usdcAta, shareAta, dep, t),
      ], signTransaction);
      setStr('');
      return { signature, note: `Deposited ${formatUsdc(dep)} USDC into ${NAME[t]} for ${formatUsdc(sharesOut)} shares.` };
    });

  return (
    <Sheet title={`Add to ${NAME[t]}`} onClose={onClose}>
      <p className="sh-p">{t === 'senior' ? 'Safe is paid back first and takes a loss only after Risky is used up.' : 'Risky earns a bigger part of the fees and takes losses first.'}</p>
      <Field label="Amount" suffix="USDC" value={str} onChange={setStr} action={{ label: 'Max', onClick: () => setStr(toInput(room !== null && room < usdc ? room : usdc)) }}
        error={err} hint={dep ? `You get about ${formatUsdc(sharesOut)} shares at 1 share = ${pool ? sharePrice(pool, t) : '…'} USDC.` : `Your wallet: ${formatUsdc(usdc)} test USDC.`} />
      <Btn onClick={onDeposit} busy={act.busy} disabled={!dep || dep <= 0n || !!err || sharesOut === 0n}>Deposit {dep ? `${formatUsdc(dep)} USDC` : 'USDC'}</Btn>
      <ActionStatus a={act} />
    </Sheet>
  );
}

function WithdrawSheet({ t, onClose }: { t: Tranche; onClose: () => void }) {
  const { connected, signTransaction } = useWallet();
  const { addrs, pool, shares, requests, refresh } = useChain();
  const owner = connected!.address;
  const [str, setStr] = useState('');
  const wd = parseUsdc(str); // shares use the same 6 decimals as USDC
  const act = useAction(async () => { await refresh(); });
  const held = shares[t];
  const worth = wd && pool ? usdcForShares(wd, supplyOf(pool, t), trancheNav(pool.stats, t)) : 0n;
  const existing = requests[t];
  const nowS = Math.floor(Date.now() / 1000);
  const unlock = nowS + Number(WITHDRAW_COOLDOWN_SECONDS);
  const claimBy = unlock + Number(CLAIM_WINDOW_SECONDS);
  const err = str && wd === null ? 'Enter a number of shares' : wd && wd > held ? `You only hold ${formatUsdc(held)} ${NAME[t]} shares.` : null;
  const day = (s: number) => new Date(s * 1000);

  const onRequest = () =>
    act.run(async () => {
      if (!addrs || !wd) throw new Error('Enter a number of shares.');
      const shareAta = await deriveAta(owner, trancheMint(addrs, t));
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner, t), deriveWithdrawRequest(addrs.program, owner, t)]);
      const { signature } = await sendTransaction(owner, [requestWithdrawIx(addrs, owner, shareAta, escrow, request, wd, t)], signTransaction);
      setStr('');
      return { signature, note: `Requested ${formatUsdc(wd)} ${NAME[t]} shares. You can claim in 3 days, within 2 days after that.` };
    });

  return (
    <Sheet title="Withdraw takes 3 days" onClose={onClose}>
      <p className="sh-p">The wait stops a rush out just before a missed payment is counted. Your price is locked when you ask.</p>
      <ul className="wd">
        {[
          { at: nowS, title: 'Ask today', sub: 'Your price is locked now' },
          { at: unlock, title: 'Wait 3 days', sub: 'Earns nothing meanwhile' },
          { at: claimBy, title: 'Claim by this day', sub: 'After that: cancel and ask again' },
        ].map((r) => (
          <li key={r.title}>
            <span className="d"><b>{day(r.at).getDate()}</b><small>{day(r.at).toLocaleString('en-GB', { month: 'short' })}</small></span>
            <span><b>{r.title}</b><small>{r.sub}</small></span>
          </li>
        ))}
      </ul>
      {existing ? (
        <p className="help warn">You already have a {NAME[t]} withdrawal waiting. Claim or cancel it first.</p>
      ) : (
        <>
          <Field label={`${NAME[t]} shares to cash in`} value={str} onChange={setStr} action={{ label: 'All', onClick: () => setStr(toInput(held)) }} error={err}
            hint={wd ? `Worth about ${formatUsdc(worth)} USDC today. You get the lower of today’s and claim-day price.` : `You hold ${formatUsdc(held)} ${NAME[t]} shares.`} />
          <Btn onClick={onRequest} busy={act.busy} disabled={!wd || wd <= 0n || !!err}>Request withdrawal</Btn>
        </>
      )}
      <ActionStatus a={act} />
    </Sheet>
  );
}

function Pending({ t, r, pool, now }: { t: Tranche; r: WithdrawRequest; pool: PoolView; now: number }) {
  const { connected, signTransaction } = useWallet();
  const { addrs, refresh } = useChain();
  const owner = connected!.address;
  const claimAct = useAction(async () => { await refresh(); });
  const cancelAct = useAction(async () => { await refresh(); });
  const unlock = Number(r.unlockTs), closes = unlock + Number(CLAIM_WINDOW_SECONDS);
  const phase = now < unlock ? 'waiting' : now <= closes ? 'open' : 'lapsed';
  const pay = claimValue(pool, t, r);
  const idle = pool.stats.idle;
  const partial = phase === 'open' && pay > idle;

  const onClaim = () =>
    claimAct.run(async () => {
      if (!addrs) throw new Error('Still reading the pool.');
      const usdcAta = await deriveAta(owner, addrs.mint);
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner, t), deriveWithdrawRequest(addrs.program, owner, t)]);
      const { signature } = await sendTransaction(owner, [createAtaIdempotentIx(owner, usdcAta, owner, addrs.mint), claimWithdrawIx(addrs, owner, escrow, request, usdcAta, t)], signTransaction);
      return { signature, note: partial ? `Claimed about ${formatUsdc(idle)} USDC. The rest stays waiting at the same price.` : `Claimed about ${formatUsdc(pay)} USDC.` };
    });
  const onCancel = () =>
    cancelAct.run(async () => {
      if (!addrs) throw new Error('Still reading the pool.');
      const shareAta = await deriveAta(owner, trancheMint(addrs, t));
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner, t), deriveWithdrawRequest(addrs.program, owner, t)]);
      const { signature } = await sendTransaction(owner, [createAtaIdempotentIx(owner, shareAta, owner, trancheMint(addrs, t)), cancelWithdrawIx(addrs, owner, shareAta, escrow, request, t)], signTransaction);
      return { signature, note: 'Cancelled. Your shares are back in your wallet.' };
    });

  return (
    <section className="pending pcard" aria-label={`${NAME[t]} withdrawal`} data-testid={`pending-${t}`}>
      <div className="hd">
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>{NAME[t]} withdrawal</h3>
        <span className={cx('tag', phase === 'open' && 'good', phase === 'lapsed' && 'bad')}>{phase === 'waiting' ? 'WAITING' : phase === 'open' ? 'READY TO CLAIM' : 'WINDOW CLOSED'}</span>
      </div>
      <p className="help">{formatUsdc(r.shares)} shares · about <b style={{ color: 'var(--ink)' }}>{formatUsdc(pay)} USDC</b></p>
      <div style={{ marginTop: 12 }}>
        <small className="help" style={{ margin: 0 }}>{phase === 'waiting' ? 'Unlocks in' : phase === 'open' ? 'Claim window closes in' : 'Closed on'}</small>
        <div className="count" data-testid="countdown">{phase === 'waiting' ? formatCountdown(unlock - now) : phase === 'open' ? formatCountdown(closes - now) : formatDateTime(closes)}</div>
      </div>
      <ul className="wd">
        <li className={cx(phase !== 'waiting' && 'past', phase === 'waiting' && 'now')}><span className="d"><b>{new Date(unlock * 1000).getDate()}</b><small>{new Date(unlock * 1000).toLocaleString('en-GB', { month: 'short' })}</small></span><span><b>Unlocks</b><small>{formatDateTime(unlock)}</small></span></li>
        <li className={cx(phase === 'open' && 'now', phase === 'lapsed' && 'past')}><span className="d"><b>{new Date(closes * 1000).getDate()}</b><small>{new Date(closes * 1000).toLocaleString('en-GB', { month: 'short' })}</small></span><span><b>Claim by</b><small>{formatDateTime(closes)} · a 2-day window</small></span></li>
      </ul>
      {phase === 'lapsed' && <p className="help warn">The 2-day claim window has closed. Cancel to get your shares back, then ask again.</p>}
      {partial && <p className="help warn">The pool has {formatUsdc(idle)} USDC free right now; the rest is out on loan. A claim pays that part now and keeps the rest waiting at the same price.</p>}
      {phase === 'waiting' && <p className="help">You get the lower of the price when you asked and the price when you claim, so a missed payment while you wait is already counted.</p>}
      <div className="stack" style={{ marginTop: 16 }}>
        <Btn onClick={onClaim} busy={claimAct.busy} disabled={phase !== 'open' || idle === 0n}>Claim USDC</Btn>
        <ActionStatus a={claimAct} />
        <Btn variant="ghost" onClick={onCancel} busy={cancelAct.busy}>Cancel and get shares back</Btn>
        <ActionStatus a={cancelAct} />
      </div>
    </section>
  );
}
