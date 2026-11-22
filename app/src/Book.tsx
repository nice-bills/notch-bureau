import { useChain } from './data';
import { PROGRAM_ID, explorerAddress } from './config';
import { formatUsdc } from './amount';
import { Notice, Stat } from './ui';
import { PoolStatsGrid, sharePrice } from './PoolStats';
import { poolAssets } from './notch';
import { MarkDefault } from './MarkDefault';

export function Book() {
  const { pool, poolLoaded, configured, addrs } = useChain();
  if (!configured) return <Notice tone="warn" title="Not configured">Set <code>VITE_USDC_MINT</code> first. See <code>.env.example</code>.</Notice>;
  if (poolLoaded && !pool) return <Notice tone="warn" title="The pool has not been created on this network">Run <code>pnpm setup:devnet</code> once.</Notice>;
  const s = pool?.stats;
  const total = s ? s.idle + s.outstanding + s.borrowerDeposits : 0n;
  const pct = (n: bigint) => (total === 0n ? 0 : Number((n * 10000n) / total) / 100);
  const util = s && poolAssets(s) > 0n ? Number((s.outstanding * 10000n) / poolAssets(s)) / 100 : 0;
  const lossRate = s && s.totalLent > 0n ? Number((s.defaultAmount * 10000n) / s.totalLent) / 100 : 0;

  return (
    <div className="book">
      <div className="lede">
        <h2>The loan book, in totals only</h2>
        <p>Anyone can check how the pool is doing. There is no list of borrowers and no income figures on this page, because none exist anywhere that we can read.</p>
      </div>

      {pool && s && (
        <>
          <div className="panel">
            <h3>Where the money sits</h3>
            <div className="bar" role="img" aria-label={`Idle ${pct(s.idle)} percent, on loan ${pct(s.outstanding)} percent, borrower deposits ${pct(s.borrowerDeposits)} percent`}>
              <span className="bar-idle" style={{ width: `${pct(s.idle)}%` }} />
              <span className="bar-loan" style={{ width: `${pct(s.outstanding)}%` }} />
              <span className="bar-dep" style={{ width: `${pct(s.borrowerDeposits)}%` }} />
            </div>
            <ul className="legend">
              <li><i className="sw sw-idle" />Ready to lend <b>{formatUsdc(s.idle, { max: 2 })}</b></li>
              <li><i className="sw sw-loan" />Out on loan <b>{formatUsdc(s.outstanding, { max: 2 })}</b></li>
              <li><i className="sw sw-dep" />Borrower deposits <b>{formatUsdc(s.borrowerDeposits, { max: 2 })}</b></li>
            </ul>
          </div>

          <div className="panel">
            <h3>Pool totals</h3>
            <PoolStatsGrid pool={pool} />
          </div>

          <div className="panel">
            <h3>Health</h3>
            <dl className="stats stats-grid">
              <Stat label="Share price" value={sharePrice(pool)} unit="USDC" hint="Above 1 means fees outweigh losses" />
              <Stat label="Share of pool on loan" value={util.toFixed(1)} unit="%" />
              <Stat label="Lost to missed payments" value={lossRate.toFixed(1)} unit="% of all lending" tone={lossRate > 0 ? 'bad' : undefined} />
              <Stat label="Shares outstanding" value={formatUsdc(pool.shareSupply, { max: 2 })} />
            </dl>
          </div>
        </>
      )}

      <div className="panel visibility">
        <h3>Who can see what</h3>
        <table>
          <thead><tr><th scope="col" /><th scope="col">Lenders and the public</th><th scope="col">Notch team</th><th scope="col">Anyone, ever</th></tr></thead>
          <tbody>
            <tr><th scope="row">A borrower’s credit limit</th><td>Yes, on Solana</td><td>Yes, same as everyone</td><td>–</td></tr>
            <tr><th scope="row">Pool totals (this page)</th><td>Yes</td><td>Yes</td><td>–</td></tr>
            <tr><th scope="row">Email text, senders, names</th><td className="no">No</td><td className="no">No</td><td className="no">Only the sealed computer</td></tr>
            <tr><th scope="row">Payment amounts and income</th><td className="no">No</td><td className="no">No</td><td className="no">Only the sealed computer</td></tr>
          </tbody>
        </table>
        <p className="fine">Limits are public per wallet because the program has to read them to lend. Wallet addresses are not tied to a name here.</p>
      </div>

      <MarkDefault />

      <p className="fine">
        Program <a href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer" className="mono">{PROGRAM_ID}</a>
        {addrs && <> · Vault <a href={explorerAddress(addrs.vault)} target="_blank" rel="noreferrer" className="mono">{addrs.vault.slice(0, 8)}…</a></>}
      </p>
    </div>
  );
}
