import { ENCLAVE_URL } from './config';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { underwrite, getAttestation, recordBytes, signatureBytes } from './enclave';
import {
  createAtaIdempotentIx,
  depositBorrowerIx,
  depositNeededFor,
  deriveAta,
  deriveDedupe,
  deriveLine,
  drawIx,
  feeFor,
  payoffFor,
  postLimitIxs,
  repayIx,
  withdrawBorrowerIx,
  decodeRecord,
} from './notch';
import { address, getAddressEncoder } from '@solana/kit';
import { formatDate, formatDateTime, formatUsdc, parseUsdc, toInput, daysLeft } from './amount';
import { ActionStatus, Btn, Field, Notice, Step, Stat, useAction } from './ui';
import { Ticket } from './Ticket';
import { ConnectPrompt } from './ConnectPrompt';

const SAMPLES = [
  { file: '/samples/momo.eml', label: 'MTN MoMo payment' },
  { file: '/samples/deel.eml', label: 'Deel payout' },
  { file: '/samples/bank.eml', label: 'Bank statement' },
];

export function Borrow() {
  const { connected, signTransaction } = useWallet();
  const { addrs, line, pool, usdc, refresh, session, configured } = useChain();
  const owner = connected?.address ?? null;
  const [uwKey, setUwKey] = useState<string | null>(null);
  const [drawStr, setDrawStr] = useState('');
  const [depStr, setDepStr] = useState('');
  const [uwBusy, setUwBusy] = useState(false);
  const [uwError, setUwError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { eml, signed } = session;

  useEffect(() => {
    getAttestation().then((a) => setUwKey(a.underwriter)).catch(() => setUwKey(null));
  }, []);

  const now = Date.now() / 1000;
  const live = line && line.limit > 0n && line.expiry > BigInt(Math.floor(now)) && !line.defaulted;
  const limit = live ? line.limit : 0n;
  const drawn = line?.drawn ?? 0n;
  const headroom = limit > drawn ? limit - drawn : 0n;
  const idle = pool?.stats.idle ?? 0n;

  // Default the amount to what is available to borrow, once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !live) return;
    seeded.current = true;
    const start = headroom < idle ? headroom : idle;
    setDrawStr(toInput(start > 0n ? start : headroom));
  }, [live, headroom, idle]);

  const draw = parseUsdc(drawStr);
  const totalAfter = drawn + (draw ?? 0n);
  const needed = draw ? depositNeededFor(totalAfter) : 0n;
  const have = line?.deposit ?? 0n;
  const toAdd = needed > have ? needed - have : 0n;
  useEffect(() => {
    setDepStr(toInput(toAdd));
  }, [toAdd]);
  const depAmt = parseUsdc(depStr);

  const posted = !!(signed && line && line.lastNonce >= BigInt(signed.nonce));
  const payoff = payoffFor(drawn);
  const fee = feeFor(drawn);
  const pastDue = !!line && line.drawn > 0n && line.due > 0n && BigInt(Math.floor(now)) > line.due;

  const after = async () => {
    await refresh();
  };
  const postAct = useAction(after);
  const depAct = useAction(after);
  const drawAct = useAction(after);
  const repayAct = useAction(after);
  const wdAct = useAction(after);

  const loadEml = async (name: string, bytes: Uint8Array) => {
    session.setEml({ name, bytes });
    session.setSigned(null);
    setUwError(null);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    await loadEml(f.name, new Uint8Array(await f.arrayBuffer()));
  };
  const loadSample = async (file: string, label: string) => {
    try {
      const r = await fetch(`${ENCLAVE_URL}${file}`);
      const text = await r.text();
      if (!r.ok || !/DKIM-Signature/i.test(text)) throw new Error('missing');
      await loadEml(file.split('/').pop()!, new TextEncoder().encode(text));
    } catch {
      setUwError(`The ${label} sample is not there yet. Run "pnpm demo:enclave" in the app folder to create the sample emails.`);
    }
  };

  const sendToSealed = async () => {
    if (!owner || !eml) return;
    setUwBusy(true);
    setUwError(null);
    try {
      const res = await underwrite(eml.bytes, owner);
      if (!res.ok) {
        setUwError(res.friendly);
        session.setSigned(null);
      } else {
        session.setSigned(res);
      }
    } catch (e) {
      setUwError(e instanceof Error ? e.message : String(e));
    } finally {
      setUwBusy(false);
    }
  };

  const onPost = () =>
    postAct.run(async () => {
      if (!owner || !addrs || !signed || !uwKey) throw new Error('Missing wallet, limit or underwriter key.');
      const record = recordBytes(signed);
      const dedupe = await deriveDedupe(addrs.program, decodeRecord(record).dedupe);
      const lineAddr = await deriveLine(addrs.program, owner);
      const ixs = postLimitIxs(addrs, { payer: owner, borrower: owner, line: lineAddr, dedupe, record }, addressBytes(uwKey), signatureBytes(signed));
      const { signature } = await sendTransaction(owner, ixs, signTransaction);
      return { signature, note: 'Your limit is now on Solana.' };
    });

  const withAta = async (owner_: ReturnType<typeof address>) => {
    const ata = await deriveAta(owner_, addrs!.mint);
    return { ata, ensure: createAtaIdempotentIx(owner_, ata, owner_, addrs!.mint) };
  };

  const onDeposit = () =>
    depAct.run(async () => {
      if (!owner || !addrs || !line || !depAmt) throw new Error('Enter a deposit amount.');
      const { ata, ensure } = await withAta(owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, depositBorrowerIx(addrs, owner, lineAddr, ata, depAmt)], signTransaction);
      return { signature, note: `Deposit added: ${formatUsdc(depAmt)} USDC.` };
    });

  const onDraw = () =>
    drawAct.run(async () => {
      if (!owner || !addrs || !draw) throw new Error('Enter how much to borrow.');
      const { ata, ensure } = await withAta(owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, drawIx(addrs, owner, lineAddr, ata, draw)], signTransaction);
      return { signature, note: `${formatUsdc(draw)} USDC sent to your wallet.` };
    });

  const onRepay = () =>
    repayAct.run(async () => {
      if (!owner || !addrs) throw new Error('Connect a wallet first.');
      const { ata, ensure } = await withAta(owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const back = line?.deposit ?? 0n;
      const { signature } = await sendTransaction(owner, [ensure, repayIx(addrs, owner, lineAddr, ata, payoff)], signTransaction);
      return { signature, note: `Repaid ${formatUsdc(payoff)} USDC. Your ${formatUsdc(back)} USDC deposit came back to you.` };
    });

  const onWithdraw = () =>
    wdAct.run(async () => {
      if (!owner || !addrs) throw new Error('Connect a wallet first.');
      const { ata, ensure } = await withAta(owner);
      const lineAddr = await deriveLine(addrs.program, owner);
      const { signature } = await sendTransaction(owner, [ensure, withdrawBorrowerIx(addrs, owner, lineAddr, ata)], signTransaction);
      return { signature, note: 'Deposit returned to your wallet.' };
    });

  const stage = useMemo(() => {
    if (!owner) return 1;
    if (!live && !signed) return 2;
    if (!live || (signed && !posted && !live)) return 3;
    if (drawn > 0n) return 6;
    if (draw && have < needed) return 4;
    return 5;
  }, [owner, live, signed, posted, drawn, draw, have, needed]);
  const st = (n: number, done: boolean): 'done' | 'active' | 'locked' => (done ? 'done' : stage === n ? 'active' : 'locked');

  if (!configured) return <Notice tone="warn" title="This app is not pointed at a Notch deployment yet">Set <code>VITE_USDC_MINT</code> (see <code>.env.example</code>) and restart. <code>pnpm setup:devnet</code> prints the values.</Notice>;

  return (
    <div className="borrow">
      <div className="borrow-main">
        <div className="lede">
          <h2>Borrow against your income, without showing it</h2>
          <p>Forward one payment email to a sealed computer. It checks the sender’s digital signature, works out a limit, and hands back only the limit. Nobody else ever sees the email.</p>
        </div>

        <Step n={1} title="Connect your wallet" state={owner ? 'done' : 'active'} summary={owner ? 'Connected' : undefined}>
          <ConnectPrompt />
        </Step>

        <Step n={2} title="Send an income email to the sealed computer" state={st(2, !!signed || !!live)} summary={signed ? `Limit ${formatUsdc(decodeRecord(recordBytes(signed)).limitMicro, { max: 2 })} USDC` : undefined}>
          <p className="step-help">Download the payment email as an <code>.eml</code> file (MTN MoMo, Deel, Wise, Payoneer, Superteam Earn, or a supported bank) and drop it here.</p>
          <div className="file-row">
            <input ref={fileInput} type="file" accept=".eml,message/rfc822" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <Btn variant="secondary" onClick={() => fileInput.current?.click()}>{eml ? 'Choose a different .eml' : 'Choose an .eml file'}</Btn>
            {eml && <span className="file-name mono">{eml.name}</span>}
          </div>
          <div className="sample-row">
            <span>No email handy? Try a demo sample:</span>
            {SAMPLES.map((s) => (
              <button key={s.file} type="button" className="chip" onClick={() => void loadSample(s.file, s.label)}>{s.label}</button>
            ))}
          </div>
          <Btn onClick={() => void sendToSealed()} busy={uwBusy} disabled={!eml || !owner}>Send to the sealed computer</Btn>
          {uwError && <Notice tone="bad" title="The sealed computer said no">{uwError}</Notice>}
          {signed && owner && (
            <>
              <Ticket result={signed} wallet={owner} />
              <details className="raw-reply">
                <summary>Show the raw reply</summary>
                <pre>{JSON.stringify(signed, null, 2)}</pre>
              </details>
            </>
          )}
        </Step>

        <Step n={3} title="Put your limit on Solana" state={st(3, !!live && (!signed || posted))} summary={live ? `Valid until ${formatDate(line!.expiry)}` : undefined}>
          <p className="step-help">One transaction posts the signed limit. The program checks the signature itself, so even we cannot make up a limit.</p>
          <Btn onClick={onPost} busy={postAct.busy} disabled={!signed || posted || !uwKey}>Post my limit</Btn>
          {!uwKey && signed && <Notice tone="warn">Could not read the underwriter’s public key from {`the sealed computer`}. Is it running?</Notice>}
          <ActionStatus a={postAct} />
        </Step>

        <Step n={4} title="Choose an amount and put down 20%" state={st(4, !!live && !!draw && have >= needed && needed > 0n)} summary={live ? `Deposit held: ${formatUsdc(have)} USDC` : undefined}>
          <p className="step-help">You hold a security deposit worth 20% of everything you owe. It stays yours: it comes back when you repay, and it only gets used if you miss the due date.</p>
          <Field label="How much do you want to borrow?" suffix="USDC" value={drawStr} onChange={setDrawStr}
            action={{ label: 'Max', onClick: () => setDrawStr(toInput(headroom < idle ? headroom : idle)) }}
            error={draw === null && drawStr ? 'Enter a number like 25 or 12.5' : draw && draw > headroom ? `Your limit leaves ${formatUsdc(headroom)} USDC available.` : draw && draw > idle ? `The pool only has ${formatUsdc(idle)} USDC free right now.` : null}
            hint={`Available to borrow: ${formatUsdc(headroom)} USDC`} />
          <dl className="calc">
            <div><dt>Total you will owe after this</dt><dd>{formatUsdc(totalAfter)}</dd></div>
            <div><dt>Deposit needed (20%)</dt><dd>{formatUsdc(needed)}</dd></div>
            <div><dt>Already deposited</dt><dd>{formatUsdc(have)}</dd></div>
            <div className="calc-total"><dt>Add now</dt><dd>{formatUsdc(toAdd)}</dd></div>
          </dl>
          <Field label="Deposit to add" suffix="USDC" value={depStr} onChange={setDepStr} />
          <Btn onClick={onDeposit} busy={depAct.busy} disabled={!live || !depAmt || depAmt <= 0n}>Add deposit</Btn>
          {usdc < (depAmt ?? 0n) && depAmt ? <Notice tone="warn">Your wallet has {formatUsdc(usdc)} test USDC. You need a bit more to cover this deposit.</Notice> : null}
          <ActionStatus a={depAct} />
        </Step>

        <Step n={5} title="Borrow" state={st(5, drawn > 0n)} summary={drawn > 0n ? `Borrowed ${formatUsdc(drawn)} USDC` : undefined}>
          <p className="step-help">{draw ? `You will receive ${formatUsdc(draw)} USDC in your wallet.` : 'Pick an amount in the step above.'} The 2% fee is paid when you repay, not now.</p>
          <Btn onClick={onDraw} busy={drawAct.busy} disabled={!live || !draw || draw <= 0n || have < needed}>Borrow {draw ? `${formatUsdc(draw)} USDC` : ''}</Btn>
          {live && draw && have < needed ? <p className="step-help warn">Add {formatUsdc(toAdd)} USDC to your deposit first.</p> : null}
          <ActionStatus a={drawAct} />
        </Step>

        <Step n={6} title="Repay" state={st(6, false)} summary={drawn > 0n && line ? `Due ${formatDate(line.due)}` : undefined}>
          {drawn > 0n && line ? (
            <>
              <dl className="calc">
                <div><dt>Borrowed</dt><dd>{formatUsdc(drawn)}</dd></div>
                <div><dt>Fee (2%, rounded up)</dt><dd>{formatUsdc(fee)}</dd></div>
                <div className="calc-total"><dt>Pay back in one go</dt><dd>{formatUsdc(payoff)}</dd></div>
              </dl>
              <p className={`step-help ${pastDue ? 'warn' : ''}`}>
                {pastDue
                  ? `This was due on ${formatDate(line.due)}. Pay now: once someone marks it as missed, your line closes for good.`
                  : `Due ${formatDateTime(line.due)} (${daysLeft(line.due)} days left). Paying on time raises your next limit.`}
              </p>
              <Btn onClick={onRepay} busy={repayAct.busy} disabled={usdc < payoff}>Repay {formatUsdc(payoff)} USDC</Btn>
              {usdc < payoff && <Notice tone="warn">Your wallet holds {formatUsdc(usdc)} USDC. The 20% deposit returns in the same step, but you need {formatUsdc(payoff - usdc)} USDC more up front to cover the repayment.</Notice>}
            </>
          ) : (
            <p className="step-help">Nothing to repay. Once you borrow, the amount and due date show up here.</p>
          )}
          <ActionStatus a={repayAct} />
        </Step>

        <Step n={7} title="Take your deposit back" state={st(7, false)}>
          <p className="step-help">{drawn > 0n ? 'Available once you owe nothing. Repaying in full returns it automatically.' : have > 0n ? `${formatUsdc(have)} USDC is waiting for you.` : 'No deposit is being held.'}</p>
          <Btn variant="secondary" onClick={onWithdraw} busy={wdAct.busy} disabled={drawn > 0n || have === 0n}>Withdraw {have > 0n ? `${formatUsdc(have)} USDC` : 'deposit'}</Btn>
          <ActionStatus a={wdAct} />
        </Step>
      </div>

      <aside className={`borrow-side${owner ? '' : ' is-empty'}`} aria-label="Your credit line">
        <div className="line-card">
          <h3>Your credit line</h3>
          {!owner ? <p className="muted">Connect a wallet to see your line.</p> : !line ? <p className="muted">No line yet. Send an income email to get one.</p> : (
            <dl className="stats">
              <Stat label="Limit" value={formatUsdc(line.limit, { max: 2 })} unit="USDC" hint={line.expiry > 0n ? `Expires ${formatDate(line.expiry)}` : undefined} />
              <Stat label="Borrowed" value={formatUsdc(line.drawn, { max: 2 })} unit="USDC" hint={line.drawn > 0n ? `Due ${formatDate(line.due)}` : 'Nothing owed'} />
              <Stat label="Your deposit" value={formatUsdc(line.deposit, { max: 2 })} unit="USDC" hint="Held, not spent" />
              <Stat label="Repaid on time" value={line.repaidOnTime} hint={line.repaidLate ? `${line.repaidLate} late` : 'Each one raises your next limit'} />
              {line.defaulted && <Stat label="Status" value="Closed" tone="bad" hint="Missed payment. This line cannot be used again." />}
            </dl>
          )}
          {owner && <p className="side-balance">Wallet balance <strong>{formatUsdc(usdc, { max: 2 })}</strong> USDC</p>}
        </div>
      </aside>
    </div>
  );
}

const addressEncoder = getAddressEncoder();
function addressBytes(a: string): Uint8Array {
  return new Uint8Array(addressEncoder.encode(address(a)));
}
