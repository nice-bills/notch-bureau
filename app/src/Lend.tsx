import { useEffect, useState } from 'react';
import { sendTransaction } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import {
  WITHDRAW_COOLDOWN_SECONDS,
  cancelWithdrawIx,
  claimWithdrawIx,
  createAtaIdempotentIx,
  depositIx,
  deriveAta,
  deriveEscrow,
  deriveWithdrawRequest,
  poolAssets,
  requestWithdrawIx,
  sharesForDeposit,
  usdcForShares,
} from './notch';
import { formatUsdc, parseUsdc, toInput } from './amount';
import { ActionStatus, Btn, Field, Notice, Stat, useAction } from './ui';
import { ConnectPrompt } from './ConnectPrompt';
import { PoolStatsGrid, sharePrice } from './PoolStats';

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

export function Lend() {
  const { connected, signTransaction } = useWallet();
  const { addrs, pool, usdc, shares, withdrawRequest, refresh, configured, poolLoaded } = useChain();
  const now = useNowSeconds();
  const owner = connected?.address ?? null;
  const [depStr, setDepStr] = useState('');
  const [wdStr, setWdStr] = useState('');
  const dep = parseUsdc(depStr);
  const wd = parseUsdc(wdStr); // shares use the same 6 decimals as USDC
  const depAct = useAction(refresh);
  const wdAct = useAction(refresh);
  const claimAct = useAction(refresh);
  const cancelAct = useAction(refresh);

  if (!configured) return <Notice tone="warn" title="Not configured">Set <code>VITE_USDC_MINT</code> first. See <code>.env.example</code>.</Notice>;
  if (poolLoaded && !pool) return <Notice tone="warn" title="The pool has not been created on this network">Run <code>pnpm setup:devnet</code> once, then reload.</Notice>;

  const assets = pool ? poolAssets(pool.stats) : 0n;
  const supply = pool?.shareSupply ?? 0n;
  const idle = pool?.stats.idle ?? 0n;
  const sharesOut = dep && pool ? sharesForDeposit(dep, supply, assets) : 0n;
  const usdcOut = wd && pool ? usdcForShares(wd, supply, assets) : 0n;
  const pending = withdrawRequest?.shares ?? 0n;
  const pendingValue = pool ? usdcForShares(pending, supply, assets) : 0n; // escrowed shares are still in `supply`
  const secsLeft = withdrawRequest ? Number(withdrawRequest.unlockTs) - now : 0;
  const unlocked = withdrawRequest !== null && secsLeft <= 0;
  const claimBlocked = unlocked && pendingValue > idle;
  const cooldownDays = Number(WITHDRAW_COOLDOWN_SECONDS / 86_400n);
  const myValue = pool ? usdcForShares(shares + pending, supply, assets) : 0n;

  const onDeposit = () =>
    depAct.run(async () => {
      if (!owner || !addrs || !dep) throw new Error('Enter an amount.');
      const usdcAta = await deriveAta(owner, addrs.mint);
      const shareAta = await deriveAta(owner, addrs.shareMint);
      const { signature } = await sendTransaction(owner, [
        createAtaIdempotentIx(owner, usdcAta, owner, addrs.mint),
        createAtaIdempotentIx(owner, shareAta, owner, addrs.shareMint),
        depositIx(addrs, owner, usdcAta, shareAta, dep),
      ], signTransaction);
      setDepStr('');
      return { signature, note: `Deposited ${formatUsdc(dep)} USDC for ${formatUsdc(sharesOut)} shares.` };
    });

  const onRequest = () =>
    wdAct.run(async () => {
      if (!owner || !addrs || !wd) throw new Error('Enter a number of shares.');
      const shareAta = await deriveAta(owner, addrs.shareMint);
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner), deriveWithdrawRequest(addrs.program, owner)]);
      const { signature } = await sendTransaction(owner, [requestWithdrawIx(addrs, owner, shareAta, escrow, request, wd)], signTransaction);
      setWdStr('');
      return { signature, note: `Requested ${formatUsdc(wd)} shares. You can claim in ${cooldownDays} days.` };
    });

  const onClaim = () =>
    claimAct.run(async () => {
      if (!owner || !addrs || !withdrawRequest) throw new Error('No withdrawal to claim.');
      const usdcAta = await deriveAta(owner, addrs.mint);
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner), deriveWithdrawRequest(addrs.program, owner)]);
      const { signature } = await sendTransaction(owner, [createAtaIdempotentIx(owner, usdcAta, owner, addrs.mint), claimWithdrawIx(addrs, owner, escrow, request, usdcAta)], signTransaction);
      return { signature, note: `Claimed about ${formatUsdc(pendingValue)} USDC.` };
    });

  const onCancel = () =>
    cancelAct.run(async () => {
      if (!owner || !addrs || !withdrawRequest) throw new Error('No withdrawal to cancel.');
      const shareAta = await deriveAta(owner, addrs.shareMint);
      const [escrow, request] = await Promise.all([deriveEscrow(addrs.program, owner), deriveWithdrawRequest(addrs.program, owner)]);
      const { signature } = await sendTransaction(owner, [cancelWithdrawIx(addrs, owner, shareAta, escrow, request)], signTransaction);
      return { signature, note: 'Cancelled. Your shares are back in your wallet.' };
    });

  return (
    <div className="lend">
      <div className="lede">
        <h2>Lend to students, earn the 2% fees</h2>
        <p>You put USDC in a shared pool and get shares. Borrowers pay a flat 2% fee, which lifts the share price. Every borrower also puts down a 20% deposit that is lost first if they don’t repay.</p>
      </div>

      {!owner ? <ConnectPrompt /> : null}

      <div className="lend-grid">
        <div className="panel">
          <h3>Pool today</h3>
          <dl className="stats stats-grid">
            <Stat label="Share price" value={pool ? sharePrice(pool) : '1.000000'} unit="USDC" hint="(idle cash + out on loan) ÷ shares" />
            <Stat label="Cash ready to lend" value={formatUsdc(idle, { max: 2 })} unit="USDC" hint="Withdrawals come from here" />
            <Stat label="Out on loan" value={formatUsdc(pool?.stats.outstanding ?? 0n, { max: 2 })} unit="USDC" />
            <Stat label="Fees earned" value={formatUsdc(pool?.stats.feesEarned ?? 0n, { max: 2 })} unit="USDC" />
            <Stat label="Missed payments" value={String(pool?.stats.defaults ?? 0n)} hint={pool && pool.stats.defaults > 0n ? `${formatUsdc(pool.stats.defaultAmount, { max: 2 })} USDC lost` : 'None so far'} tone={pool && pool.stats.defaults > 0n ? 'bad' : undefined} />
            <Stat label="Borrower deposits" value={formatUsdc(pool?.stats.borrowerDeposits ?? 0n, { max: 2 })} unit="USDC" hint="Held aside, not lendable" />
          </dl>
        </div>

        <div className="panel">
          <h3>Your position</h3>
          <dl className="stats">
            <Stat label="Your shares" value={formatUsdc(shares, { max: 4 })} hint={owner ? `Worth about ${formatUsdc(myValue, { max: 2 })} USDC${pending > 0n ? ` (incl. ${formatUsdc(pending, { max: 4 })} waiting to withdraw)` : ''}` : 'Connect a wallet'} />
            <Stat label="Wallet USDC" value={formatUsdc(usdc, { max: 2 })} unit="USDC" />
          </dl>
        </div>

        <div className="panel">
          <h3>Deposit</h3>
          <Field label="Amount" suffix="USDC" value={depStr} onChange={setDepStr} action={{ label: 'Max', onClick: () => setDepStr(toInput(usdc)) }}
            error={depStr && dep === null ? 'Enter a number like 100 or 12.5' : dep && dep > usdc ? `Your wallet only holds ${formatUsdc(usdc)} USDC.` : null}
            hint={dep ? `You receive about ${formatUsdc(sharesOut)} shares` : 'Shares are priced at what the pool is worth right now.'} />
          <Btn onClick={onDeposit} busy={depAct.busy} disabled={!owner || !dep || dep <= 0n || sharesOut === 0n}>Deposit USDC</Btn>
          <ActionStatus a={depAct} />
        </div>

        <div className="panel">
          <h3>Withdraw</h3>
          {withdrawRequest ? (
            <>
              <dl className="stats">
                <Stat label="Waiting to withdraw" value={formatUsdc(withdrawRequest.shares, { max: 4 })} unit="shares" hint={`Worth about ${formatUsdc(pendingValue, { max: 2 })} USDC at today’s price`} />
                <Stat label={unlocked ? 'Ready' : 'Unlocks in'} value={unlocked ? 'Now' : formatCountdown(secsLeft)} hint={new Date(Number(withdrawRequest.unlockTs) * 1000).toLocaleString()} tone={unlocked ? 'good' : undefined} />
              </dl>
              <p className="field-hint">You are paid at the share price when you claim, so any missed payment recorded while you wait is already counted. Your shares stay in the pool until then.</p>
              {claimBlocked ? <p className="field-hint">The pool only has {formatUsdc(idle)} USDC free right now; the rest is out on loan. Claim again once loans are repaid, or cancel.</p> : null}
              <Btn variant="secondary" onClick={onClaim} busy={claimAct.busy} disabled={!owner || !unlocked || claimBlocked}>Claim USDC</Btn>
              <ActionStatus a={claimAct} />
              <Btn variant="quiet" onClick={onCancel} busy={cancelAct.busy} disabled={!owner}>Cancel and get shares back</Btn>
              <ActionStatus a={cancelAct} />
            </>
          ) : (
            <>
              <Field label="Shares to cash in" value={wdStr} onChange={setWdStr} action={{ label: 'All', onClick: () => setWdStr(toInput(shares)) }}
                error={wdStr && wd === null ? 'Enter a number of shares' : wd && wd > shares ? `You only hold ${formatUsdc(shares)} shares.` : null}
                hint={wd ? `Worth about ${formatUsdc(usdcOut)} USDC today. The final amount is set when you claim.` : `Two steps: request now, claim after ${cooldownDays} days. This stops anyone leaving just before a missed payment is recorded.`} />
              <Btn variant="secondary" onClick={onRequest} busy={wdAct.busy} disabled={!owner || !wd || wd <= 0n || wd > shares}>Request withdrawal</Btn>
              <ActionStatus a={wdAct} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { PoolStatsGrid };
