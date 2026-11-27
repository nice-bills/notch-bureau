// Devnet only: a one-tap way to get test SOL (network fees) and test USDC, so a judge with a fresh wallet can try everything.
import { useState } from 'react';
import { useWallet } from './wallet';
import { useChain } from './data';
import { useUi } from './App';
import { requestFaucet } from './enclave';
import { explorerTx, FAUCET_URL } from './config';
import { Btn } from './ui';
import { MIN_FEE_LAMPORTS } from './chain';

export function FaucetButton({ label = 'Get test SOL and USDC', variant = 'secondary' }: { label?: string; variant?: 'primary' | 'secondary' }) {
  const { connected } = useWallet();
  const { refresh } = useChain();
  const { att } = useUi();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);
  if (!connected) return null;
  const has = FAUCET_URL || (att && att !== 'down' && att.faucet);
  if (!has) {
    return <p className="help">Get free devnet SOL at <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a> (choose Devnet, paste your address).</p>;
  }
  const onTap = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await requestFaucet(connected.address);
      await refresh();
      setMsg({ ok: true, text: `Sent ${r.sol} SOL and ${r.usdc} test USDC to your wallet.`, sig: r.signature });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="faucet">
      {!msg?.ok && <Btn variant={variant} small onClick={() => void onTap()} busy={busy}>{label}</Btn>}
      {msg && (
        <p className={msg.ok ? 'help good' : 'help warn'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}{msg.sig && <> <a href={explorerTx(msg.sig)} target="_blank" rel="noreferrer">View</a></>}
        </p>
      )}
    </div>
  );
}

/** A small card shown when the wallet is empty: no SOL for fees, or no test USDC to try with. */
export function NeedsTestMoney({ need }: { need: 'sol' | 'usdc' | 'both' }) {
  const { sol, usdc } = useChain();
  const filled = need === 'usdc' ? usdc > 0n : sol !== null && sol >= MIN_FEE_LAMPORTS;
  const text = need === 'usdc' ? 'Your wallet has no test USDC yet.' : 'Your wallet has no devnet SOL for network fees yet.';
  return (
    <section className="card pcard needs-money" aria-label="Test money">
      {/* once it arrived, only the button's own "Sent …" line remains: one message, no second tap */}
      {!filled && <><b>{text}</b><p className="help" style={{ margin: '4px 0 12px' }}>It’s free test money on Solana devnet, no real funds.</p></>}
      <FaucetButton variant="primary" />
    </section>
  );
}

/** Keep showing the test-money card after it worked (the refreshed balance would otherwise hide its "Sent…" message). */
export function useSticky<T>(v: T | null): T | null {
  const [last, setLast] = useState<T | null>(v);
  if (v !== null && v !== last) setLast(v);
  return v ?? last;
}
