import { useEffect, useState } from 'react';
import { address, type Address } from '@solana/kit';
import { fetchLine, sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { isPastDue, markDefaultIx, deriveLine, type CreditLine } from './notch';
import { formatUsdc, shortAddr } from './amount';
import { ActionStatus, Btn, Field, Notice, useAction } from './ui';

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'none' } | { state: 'error'; message: string } | { state: 'found'; line: CreditLine };

/** Anyone can close out an overdue loan: the program only checks the due date, not who calls. */
export function MarkDefault() {
  const { connected, signTransaction } = useWallet();
  const { addrs, refresh } = useChain();
  const [input, setInput] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const act = useAction(async () => {
    await refresh();
    setNonce((n) => n + 1);
  });
  const [nonce, setNonce] = useState(0);

  let borrower: Address | null = null;
  try {
    if (input.trim()) borrower = address(input.trim());
  } catch {
    borrower = null;
  }
  const badInput = input.trim() !== '' && borrower === null;

  useEffect(() => {
    if (!borrower) {
      setLookup({ state: 'idle' });
      return;
    }
    let live = true;
    setLookup({ state: 'loading' });
    fetchLine(borrower)
      .then((line) => live && setLookup(line ? { state: 'found', line } : { state: 'none' }))
      .catch((e) => live && setLookup({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
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
    <div className="panel mark-default">
      <h3>Mark overdue loan as defaulted</h3>
      <p className="step-help">
        Anyone can do this once a loan is past its due date. The borrower’s 20% deposit is handed to the lenders, the rest of the loss is written off,
        and that wallet can never borrow again. The program refuses it before the due date.
      </p>
      <Field
        label="Borrower wallet"
        inputMode="text"
        value={input}
        onChange={setInput}
        placeholder="Wallet address of the borrower"
        error={badInput ? 'That is not a valid wallet address.' : null}
      />
      {lookup.state === 'loading' && <p className="step-help">Looking up the credit line…</p>}
      {lookup.state === 'none' && <Notice tone="info">This wallet has no credit line here.</Notice>}
      {lookup.state === 'error' && <Notice tone="warn">{lookup.message}</Notice>}
      {line && (
        <Notice tone={overdue ? 'bad' : line.defaulted ? 'warn' : 'info'} title={line.defaulted ? 'Already defaulted' : overdue ? 'Overdue' : 'Not overdue'}>
          {line.defaulted
            ? 'This line was already closed after a missed payment.'
            : line.drawn === 0n
              ? 'Nothing is borrowed right now.'
              : overdue
                ? `Owes ${formatUsdc(line.drawn)} USDC, due ${new Date(Number(line.due) * 1000).toLocaleString()}.`
                : `Owes ${formatUsdc(line.drawn)} USDC, due ${new Date(Number(line.due) * 1000).toLocaleString()}. Too early to mark.`}
        </Notice>
      )}
      {!connected && <p className="step-help">Connect a wallet to send this. You only pay the network fee.</p>}
      <Btn variant="secondary" onClick={onMark} busy={act.busy} disabled={!connected || !borrower || !overdue}>
        Mark as defaulted
      </Btn>
      <ActionStatus a={act} />
    </div>
  );
}
