import { useEffect, useState } from 'react';
import { address, type Address } from '@solana/kit';
import { fetchLine, sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { PROGRAM_ID, explorerAddress } from './config';
import { deriveLine, isPastDue, markDefaultIx, poolAssets, type CreditLine } from './notch';
import { formatUsdc, shortAddr } from './amount';
import { ActionStatus, Btn, Field, Icon, Notice, Stat, useAction } from './ui';
import { Banners, useUi } from './App';
import { Avatar } from './Home';
import { NAME, sharePrice } from './Lend';

export function Pool() {
  const { pool, poolLoaded, addrs } = useChain();
  const { go } = useUi();
  const s = pool?.stats;
  const total = s ? s.idle + s.outstanding + s.borrowerDeposits : 0n;
  const pct = (n: bigint) => (total === 0n ? 0 : Number((n * 10000n) / total) / 100);
  const util = s && poolAssets(s) > 0n ? Number((s.outstanding * 10000n) / poolAssets(s)) / 100 : 0;
  const lossRate = s && s.totalLent > 0n ? Number((s.defaultAmount * 10000n) / s.totalLent) / 100 : 0;

  return (
    <div className="book">
      <div className="ahead">
        <div><small>Totals only. No list of borrowers.</small><h1>The loan book</h1></div>
        <Avatar />
      </div>
      <Banners />
      {!poolLoaded ? (
        <div className="card pcard" aria-busy="true"><h3>Reading the pool…</h3><div className="bar3"><span className="skel" style={{ width: '100%' }} /></div></div>
      ) : !pool || !s ? null : (
        <>
          <section className="card pcard" aria-labelledby="where-h">
            <h3 id="where-h">Where the money sits</h3>
            <div className="bar3" role="img" aria-label={`Ready to lend ${pct(s.idle)} percent, on loan ${pct(s.outstanding)} percent, borrower deposits ${pct(s.borrowerDeposits)} percent`}>
              <span className="b-idle" style={{ width: `${pct(s.idle)}%` }} />
              <span className="b-loan" style={{ width: `${pct(s.outstanding)}%` }} />
              <span className="b-dep" style={{ width: `${pct(s.borrowerDeposits)}%` }} />
            </div>
            <ul className="legend">
              <li><i style={{ background: '#7FA4E6' }} />Ready to lend <b>{formatUsdc(s.idle, { max: 2 })}</b></li>
              <li><i style={{ background: '#8E7CC8' }} />Out on loan <b>{formatUsdc(s.outstanding, { max: 2 })}</b></li>
              <li><i style={{ background: '#E3A857' }} />Borrower deposits <b>{formatUsdc(s.borrowerDeposits, { max: 2 })}</b></li>
            </ul>
          </section>

          <section className="card pcard" aria-labelledby="tot-h" data-testid="totals">
            <h3 id="tot-h">Pool totals</h3>
            <dl className="stats">
              <Stat label="Lent out, all time" value={formatUsdc(s.totalLent, { max: 2 })} unit="USDC" />
              <Stat label="Out on loan now" value={formatUsdc(s.outstanding, { max: 2 })} unit="USDC" />
              <Stat label="Cash ready to lend" value={formatUsdc(s.idle, { max: 2 })} unit="USDC" />
              <Stat label="Fees earned" value={formatUsdc(s.feesEarned, { max: 2 })} unit="USDC" />
              <Stat label="Missed payments" value={String(s.defaults)} hint={`${formatUsdc(s.defaultAmount, { max: 2 })} USDC lost`} tone={s.defaults > 0n ? 'bad' : undefined} />
              <Stat label="Borrower deposits" value={formatUsdc(s.borrowerDeposits, { max: 2 })} unit="USDC" hint="Held aside, covers losses first" />
            </dl>
          </section>

          <section className="card pcard" aria-labelledby="hl-h" data-testid="health">
            <h3 id="hl-h">Health</h3>
            <dl className="stats">
              <Stat label={`${NAME.senior} share price`} value={sharePrice(pool, 'senior')} unit="USDC" />
              <Stat label={`${NAME.junior} share price`} value={sharePrice(pool, 'junior')} unit="USDC" hint="Above 1 means fees beat losses" />
              <Stat label="Share of pool on loan" value={util.toFixed(1)} unit="%" />
              <Stat label="Lost to missed payments" value={lossRate.toFixed(1)} unit="% of all lending" tone={lossRate > 0 ? 'bad' : undefined} />
              <Stat label={`${NAME.senior} shares`} value={formatUsdc(pool.seniorSupply, { max: 2 })} />
              <Stat label={`${NAME.junior} shares`} value={formatUsdc(pool.juniorSupply, { max: 2 })} />
            </dl>
          </section>
        </>
      )}

      <section className="card pcard visibility" aria-labelledby="vis-h">
        <h3 id="vis-h">Who can see what</h3>
        <table className="vis">
          <thead><tr><th scope="col" /><th scope="col">Public</th><th scope="col">Notch team</th></tr></thead>
          <tbody>
            <tr><th scope="row">A wallet’s credit limit</th><td>Yes, on Solana</td><td>Same as everyone</td></tr>
            <tr><th scope="row">Pool totals</th><td>Yes</td><td>Yes</td></tr>
            <tr><th scope="row">Email text, senders, names</th><td className="no">No</td><td className="no">No</td></tr>
            <tr><th scope="row">Payment amounts and income</th><td className="no">No</td><td className="no">No</td></tr>
          </tbody>
        </table>
        <p className="help">Only the sealed computer ever reads a statement. Limits are public per wallet because the program needs them to lend.</p>
      </section>

      <MarkDefault />

      <ul className="list pcard" style={{ marginTop: 16 }}>
        <li><button type="button" className="item tap" onClick={() => go('cheat')}><span className="ico"><Icon name="shield" /></span><span className="t"><b>Try to cheat it</b><small>Edit an email, reuse one, forge a limit</small></span><span className="chev"><Icon name="chev" /></span></button></li>
      </ul>
      <p className="help pad" style={{ fontSize: 12 }}>
        Program <a href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer" className="mono">{shortAddr(PROGRAM_ID, 6)}</a>
        {addrs && <> · Vault <a href={explorerAddress(addrs.vault)} target="_blank" rel="noreferrer" className="mono">{shortAddr(addrs.vault, 6)}</a></>}
      </p>
    </div>
  );
}

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'none' } | { state: 'error'; message: string } | { state: 'found'; line: CreditLine };

/** Anyone can close out an overdue loan: the program only checks the due date, not who calls. */
function MarkDefault() {
  const { connected, signTransaction } = useWallet();
  const { addrs, refresh } = useChain();
  const { openSignIn } = useUi();
  const [input, setInput] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [nonce, setNonce] = useState(0);
  const act = useAction(async () => { await refresh(); setNonce((n) => n + 1); });

  let borrower: Address | null = null;
  try { if (input.trim()) borrower = address(input.trim()); } catch { borrower = null; }
  const badInput = input.trim() !== '' && borrower === null;

  useEffect(() => {
    if (!borrower) { setLookup({ state: 'idle' }); return; }
    let live = true;
    setLookup({ state: 'loading' });
    fetchLine(borrower)
      .then((line) => live && setLookup(line ? { state: 'found', line } : { state: 'none' }))
      .catch((e) => live && setLookup({ state: 'error', message: `Could not read that line from Solana: ${e instanceof Error ? e.message : String(e)}` }));
    return () => { live = false; };
  }, [borrower, nonce]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const line = lookup.state === 'found' ? lookup.line : null;
  const overdue = line ? isPastDue(line, now) : false;

  const onMark = () =>
    act.run(async () => {
      if (!connected || !addrs || !borrower) throw new Error('Connect a wallet and enter a borrower address.');
      const lineAddr = await deriveLine(addrs.program, borrower);
      const { signature } = await sendTransaction(connected.address, [markDefaultIx(addrs, lineAddr)], signTransaction);
      return { signature, note: `Marked ${shortAddr(borrower)} as defaulted. Their deposit now covers the lenders’ loss.` };
    });

  return (
    <section className="card pcard mark-default" aria-labelledby="md-h">
      <h3 id="md-h">Mark an overdue loan as missed</h3>
      <p className="sub">Anyone can do this once a loan is past due. The borrower’s 20% deposit goes to the lenders, the rest of the loss is written off, and that wallet can never borrow again. The program refuses it before the due date.</p>
      <Field label="Borrower wallet" inputMode="text" value={input} onChange={setInput} placeholder="Wallet address" error={badInput ? 'That is not a valid wallet address.' : null} />
      {lookup.state === 'loading' && <p className="help">Looking up the credit line…</p>}
      {lookup.state === 'none' && <Notice tone="info">This wallet has no credit line here.</Notice>}
      {lookup.state === 'error' && <Notice tone="warn">{lookup.message}</Notice>}
      {line && (
        <Notice tone={overdue ? 'bad' : line.defaulted ? 'warn' : 'info'} title={line.defaulted ? 'Already defaulted' : overdue ? 'Overdue' : 'Not overdue'}>
          {line.defaulted ? 'This line was already closed after a missed payment.'
            : line.drawn === 0n ? 'Nothing is borrowed right now.'
            : overdue ? `Owes ${formatUsdc(line.drawn)} USDC, due ${new Date(Number(line.due) * 1000).toLocaleString()}.`
            : `Owes ${formatUsdc(line.drawn)} USDC, due ${new Date(Number(line.due) * 1000).toLocaleString()}. Too early to mark.`}
        </Notice>
      )}
      {!connected && <p className="help">Connect a wallet to send this. You only pay the network fee. <button type="button" onClick={openSignIn} style={{ color: 'var(--ultra)', fontWeight: 600 }}>Connect</button></p>}
      <div style={{ marginTop: 16 }}>
        <Btn variant="danger" onClick={onMark} busy={act.busy} disabled={!connected || !borrower || !overdue}>Mark as defaulted</Btn>
      </div>
      <ActionStatus a={act} />
    </section>
  );
}
