import { useMemo, useState } from 'react';
import { address } from '@solana/kit';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { createAtaIdempotentIx, deriveAta, deriveLine, feeFor, payoffFor, repayIx, withdrawBorrowerIx, type NotchAddresses } from './notch';
import { formatDate, formatDateTime, formatUsdc, shortAddr, daysLeft } from './amount';
import { envelope, foilCard, stamp, type Ink, type Motif } from './art';
import { ActionStatus, Btn, Icon, Money, Sheet, Skel, cx, useAction } from './ui';
import { Banners, useUi } from './App';

/** Ata + idempotent create, so a wallet that never held test USDC still works. */
export async function withAta(a: NotchAddresses, owner: ReturnType<typeof address>) {
  const ata = await deriveAta(owner, a.mint);
  return { ata, ensure: createAtaIdempotentIx(owner, ata, owner, a.mint) };
}

/** The state of a credit line in plain terms. */
export function lineState(line: ReturnType<typeof useChain>['line'], nowS = Math.floor(Date.now() / 1000)) {
  const live = !!line && line.limit > 0n && line.expiry > BigInt(nowS) && !line.defaulted;
  const limit = live ? line!.limit : 0n;
  const drawn = line?.drawn ?? 0n;
  const headroom = limit > drawn ? limit - drawn : 0n;
  const pastDue = !!line && line.drawn > 0n && line.due > 0n && BigInt(nowS) > line.due;
  const expired = !!line && line.limit > 0n && !line.defaulted && line.expiry <= BigInt(nowS);
  return { live, limit, drawn, headroom, pastDue, expired, deposit: line?.deposit ?? 0n };
}

export function Avatar() {
  const { connected } = useWallet();
  const { openAccount, openSignIn } = useUi();
  return connected ? (
    <button type="button" className="av tap wallet-pill" onClick={openAccount} aria-label={`Your wallet ${shortAddr(connected.address)}`} title={connected.address}>
      <img src={connected.wallet.icon} alt="" />
    </button>
  ) : (
    <Btn small onClick={openSignIn}>Connect wallet</Btn>
  );
}

export function Home() {
  const { connected } = useWallet();
  if (!connected) return <Welcome />;
  return <HomeConnected />;
}

const WALL: [Ink, Motif, string][] = [['verm', 'sun', '5'], ['ultra', 'bank', '10'], ['ochre', 'kente', '20'], ['sea', 'waves', '2'], ['verm', 'horn', '1'], ['ultra', 'waves', '50'], ['ochre', 'sun', '5'], ['sea', 'kente', '10']];
const CAPS = ['GHANA', 'NOTCH', 'AIRMAIL', 'ACCRA', 'POSTE', 'KUMASI', 'TAMALE', 'CEDI'];

function Welcome() {
  const { openSignIn, go, pollar } = useUi();
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
  return (
    <section className="welcome" aria-labelledby="w-h">
      <div className="brandpill glass lens">
        <svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="8" fill="#111A33" /><path d="M8.5 18V8.5l9 9V8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        notch
      </div>
      <Banners />
      <div className="lede">
        <h1 id="w-h">Borrow against your income, without showing it.</h1>
        <p>Your provider emails a statement to your own Notch inbox. A sealed computer reads it, and only a signed limit comes back.</p>
      </div>
      <div className="hero" aria-hidden="true"><svg viewBox="0 0 312 204" dangerouslySetInnerHTML={{ __html: env }} /></div>
      <div className="wall" aria-hidden="true"><div className="rows" dangerouslySetInnerHTML={{ __html: wall }} /></div>
      <div className="foot">
        {pollar?.step === 'authenticated' && (
          <div className="notice notice-info" role="status">
            <strong>Signed in with Google{pollar.solana ? ` · wallet ${shortAddr(pollar.solana)}` : ''}</strong>
            <span>To post a limit and borrow, connect a self-custody wallet too. Pollar wallets can’t sign Notch’s transactions yet.</span>
          </div>
        )}
        <Btn onClick={openSignIn}>Get started</Btn>
        <Btn variant="ghost" onClick={() => go('lend')}>I want to lend instead</Btn>
      </div>
    </section>
  );
}

function HomeConnected() {
  const { connected, signTransaction } = useWallet();
  const { line, usdc, loading, addrs, refresh, patch } = useChain();
  const { go } = useUi();
  const owner = connected!.address;
  const s = lineState(line);
  const [repayOpen, setRepayOpen] = useState(false);
  const wdAct = useAction(refresh);
  const card = useMemo(() => foilCard(formatUsdc(s.limit, { max: 2 }).replace(/\.00$/, ''), line ? `GOOD UNTIL ${formatDate(line.expiry).toUpperCase()}` : ''), [s.limit, line]);
  const frac = s.limit > 0n ? Number((s.headroom * 1000n) / s.limit) / 1000 : 0;

  const onWithdraw = () =>
    wdAct.run(async () => {
      if (!addrs) throw new Error('Still reading the pool. Try again in a moment.');
      const { ata, ensure } = await withAta(addrs, owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const back = line?.deposit ?? 0n;
      const { signature } = await sendTransaction(owner, [ensure, withdrawBorrowerIx(addrs, owner, lineAddr, ata)], signTransaction);
      patch({ line: { deposit: 0n }, usdc: usdc + back });
      return { signature, note: 'Deposit returned to your wallet.' };
    });

  return (
    <div className="home">
      <div className="hhead">
        <div className="who">
          <small>Hello, {shortAddr(owner)}</small>
          <b>{loading ? 'Reading your line…' : s.live ? (s.drawn > 0n ? (s.pastDue ? 'Your loan is overdue.' : 'Your stamp is working.') : 'Your stamp is ready.') : line?.defaulted ? 'This line is closed.' : 'Let’s get your limit.'}</b>
        </div>
        <Avatar />
      </div>
      <Banners />

      {loading ? (
        <div className="balcard pcard" aria-busy="true"><small>Your credit line</small><div className="amt"><Skel loading>0</Skel></div></div>
      ) : line?.defaulted ? (
        <div className="card pcard empty" role="status">
          <div className="ico" style={{ background: 'var(--verm-tint)', color: 'var(--verm)' }}><Icon name="lock" /></div>
          <b>This credit line is closed</b>
          <p>A payment was missed, so the deposit went to the lenders. This wallet can’t borrow again.</p>
        </div>
      ) : !s.live ? (
        <>
          <div className="card pcard empty">
            <div className="ico"><Icon name="mail" /></div>
            <b>{s.expired ? 'Your limit has expired' : 'No limit yet'}</b>
            <p>{s.expired ? 'Send a fresh statement to get a new one.' : 'Have your mobile money provider email a statement to your own Notch inbox. MTN MoMo works today.'}</p>
          </div>
          <div className="actions"><Btn onClick={() => go('limit')}><Icon name="mail" />Get my limit</Btn></div>
          {s.deposit > 0n ? <DepositBack amount={s.deposit} act={wdAct} onWithdraw={onWithdraw} drawn={s.drawn} /> : wdAct.note && <div style={{ margin: "16px 24px 0" }}><ActionStatus a={wdAct} /></div>}
        </>
      ) : (
        <>
          <div className="foilcard" aria-hidden="true"><svg viewBox="0 0 342 204" dangerouslySetInnerHTML={{ __html: card }} /><i className="gloss" /></div>
          <section className="balcard pcard line-card" aria-label="Your credit line">
            <div className="bl1">
              <small>You can borrow</small>
              {s.drawn > 0n && <span className={cx('tag', s.pastDue && 'bad')}>{s.pastDue ? 'OVERDUE' : `DUE ${formatDate(line!.due).toUpperCase()}`}</span>}
            </div>
            <div className="amt" data-testid="available"><Money v={formatUsdc(s.headroom, { max: 2 })} /><span className="u">USDC</span></div>
            <div className="meter" aria-hidden="true"><i style={{ transform: `scaleX(${frac})` }} /></div>
            <div className="gmeta"><span>Used {formatUsdc(s.drawn, { max: 2 })}</span><span data-testid="limit">{formatUsdc(s.limit, { max: 2 })} limit</span></div>
          </section>
          <div className="acts">
            <Btn onClick={() => go('borrow')} disabled={s.headroom === 0n || s.pastDue}>Borrow</Btn>
            <Btn variant="secondary" onClick={() => setRepayOpen(true)} disabled={s.drawn === 0n}><Icon name="repay" />Pay back</Btn>
          </div>
          {s.drawn > 0n && (
            <div className={cx('duec pcard', s.pastDue && 'late')}>
              <span className="q"><Icon name="clock" /></span>
              <span className="t">
                <b>Pay {formatUsdc(payoffFor(s.drawn))} USDC</b>
                <small>{s.pastDue ? `Was due ${formatDate(line!.due)}. Pay now before it is marked as missed.` : `By ${formatDateTime(line!.due)} · ${daysLeft(line!.due)} days left`}</small>
              </span>
              <Btn small onClick={() => setRepayOpen(true)}>Pay</Btn>
            </div>
          )}
          {s.deposit > 0n && s.drawn === 0n ? <DepositBack amount={s.deposit} act={wdAct} onWithdraw={onWithdraw} drawn={s.drawn} /> : wdAct.note && <div style={{ margin: "16px 24px 0" }}><ActionStatus a={wdAct} /></div>}
        </>
      )}

      {!loading && line && (
        <>
          <div className="sect"><h2>Your line</h2></div>
          <ul className="list pcard">
            <li className="item"><span className="ico"><Icon name="shield" /></span><span className="t"><b>Deposit held</b><small>20% of what you owe, comes back when you pay</small></span><span className="v" data-testid="deposit">{formatUsdc(line.deposit, { max: 2 })}</span></li>
            <li className="item"><span className="ico"><Icon name="check" /></span><span className="t"><b>Repaid on time</b><small>{line.repaidLate ? `${line.repaidLate} late` : 'Each one raises your next limit'}</small></span><span className="v" data-testid="on-time">{line.repaidOnTime}</span></li>
            <li className="item"><span className="ico"><Icon name="wallet" /></span><span className="t"><b>In your wallet</b><small>Test USDC on devnet</small></span><span className="v" data-testid="wallet-usdc">{formatUsdc(usdc, { max: 2 })}</span></li>
            {s.live && <li><button type="button" className="item tap" onClick={() => go('limit')}><span className="ico"><Icon name="mail" /></span><span className="t"><b>Send a new statement</b><small>Get a fresh stamp any time</small></span><span className="chev"><Icon name="chev" /></span></button></li>}
          </ul>
        </>
      )}
      {!loading && !line && (
        <ul className="list pcard" style={{ marginTop: 16 }}>
          <li className="item"><span className="ico"><Icon name="wallet" /></span><span className="t"><b>In your wallet</b><small>Test USDC on devnet</small></span><span className="v" data-testid="wallet-usdc">{formatUsdc(usdc, { max: 2 })}</span></li>
        </ul>
      )}
      {repayOpen && line && <RepaySheet onClose={() => setRepayOpen(false)} />}
    </div>
  );
}

function DepositBack({ amount, act, onWithdraw, drawn }: { amount: bigint; act: ReturnType<typeof useAction>; onWithdraw: () => void; drawn: bigint }) {
  return (
    <section className="card pcard" aria-label="Your deposit">
      <h3>Your deposit is waiting</h3>
      <p className="sub">{formatUsdc(amount)} USDC is waiting for you. You owe nothing, so you can take it back now.</p>
      <div style={{ marginTop: 16 }}>
        <Btn variant="secondary" onClick={onWithdraw} busy={act.busy} disabled={drawn > 0n}>Withdraw {formatUsdc(amount)} USDC</Btn>
      </div>
      <ActionStatus a={act} />
    </section>
  );
}

function RepaySheet({ onClose }: { onClose: () => void }) {
  const { connected, signTransaction } = useWallet();
  const { line, usdc, addrs, refresh, patch } = useChain();
  const owner = connected!.address;
  const drawn = line?.drawn ?? 0n;
  const payoff = payoffFor(drawn);
  const fee = feeFor(drawn);
  const back = line?.deposit ?? 0n;
  const act = useAction(refresh);
  const [paid, setPaid] = useState<{ payoff: bigint; back: bigint } | null>(null);
  const short = usdc < payoff;

  const onRepay = () =>
    act.run(async () => {
      if (!addrs) throw new Error('Still reading the pool. Try again in a moment.');
      const { ata, ensure } = await withAta(addrs, owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, repayIx(addrs, owner, lineAddr, ata, payoff)], signTransaction);
      patch({ line: { drawn: 0n, deposit: 0n }, usdc: usdc - payoff + back });
      setPaid({ payoff, back });
      return { signature, note: `Repaid ${formatUsdc(payoff)} USDC. Your ${formatUsdc(back)} USDC deposit came back to you.` };
    });

  return (
    <Sheet title={paid ? 'Paid back' : 'Pay back'} onClose={onClose}>
      {!paid ? (
        <>
          <p className="sh-p">One payment clears the loan. Your deposit comes back in the same step.</p>
          <div className="rcpt">
            <div className="r"><span>Borrowed</span><b>{formatUsdc(drawn)}</b></div>
            <div className="r"><span>Fee, 2%</span><b>{formatUsdc(fee)}</b></div>
            <div className="r total"><span>You pay</span><b>{formatUsdc(payoff)}</b></div>
            <div className="r"><span>Deposit back</span><b style={{ color: 'var(--green)' }}>+{formatUsdc(back)}</b></div>
          </div>
          {short && <p className="help warn">Your wallet holds {formatUsdc(usdc)} USDC. You need {formatUsdc(payoff - usdc)} more up front; the deposit returns after.</p>}
          <Btn onClick={onRepay} busy={act.busy} disabled={short || drawn === 0n}>Repay {formatUsdc(payoff)} USDC</Btn>
        </>
      ) : (
        <div style={{ textAlign: 'center', paddingTop: 8 }}>
          <div className="done-amt">{formatUsdc(paid.payoff, { max: 2 })} USDC</div>
          <p className="sh-p">paid. Your {formatUsdc(paid.back, { max: 2 })} USDC deposit is back in your wallet.</p>
          <Btn onClick={onClose}>Done</Btn>
        </div>
      )}
      <ActionStatus a={act} />
    </Sheet>
  );
}
