import type { PoolView } from './chain';
import { poolAssets } from './notch';
import { formatUsdc } from './amount';
import { Stat } from './ui';

/** Share price as a 6 decimal string; 1.000000 before any shares exist. */
export function sharePrice(p: PoolView): string {
  const assets = poolAssets(p.stats);
  if (p.shareSupply === 0n || assets === 0n) return '1.000000';
  const scaled = (assets * 1_000_000n) / p.shareSupply;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, '0')}`;
}

export function PoolStatsGrid({ pool }: { pool: PoolView }) {
  const s = pool.stats;
  return (
    <dl className="stats stats-grid">
      <Stat label="Lent out, all time" value={formatUsdc(s.totalLent, { max: 2 })} unit="USDC" />
      <Stat label="Out on loan now" value={formatUsdc(s.outstanding, { max: 2 })} unit="USDC" />
      <Stat label="Cash ready to lend" value={formatUsdc(s.idle, { max: 2 })} unit="USDC" />
      <Stat label="Fees earned" value={formatUsdc(s.feesEarned, { max: 2 })} unit="USDC" />
      <Stat label="Missed payments" value={String(s.defaults)} hint={`${formatUsdc(s.defaultAmount, { max: 2 })} USDC lost`} tone={s.defaults > 0n ? 'bad' : undefined} />
      <Stat label="Borrower deposits" value={formatUsdc(s.borrowerDeposits, { max: 2 })} unit="USDC" hint="Held aside, covers losses first" />
    </dl>
  );
}
