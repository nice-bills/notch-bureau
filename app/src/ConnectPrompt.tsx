import { useState } from 'react';
import { useWallet } from './wallet';
import { Btn, Notice } from './ui';
import { shortAddr } from './amount';

export function WalletButton() {
  const { connected, wallets, connect, connecting, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (connected) {
    return (
      <button type="button" className="wallet-pill" onClick={() => void disconnect()} title="Disconnect">
        <img src={connected.wallet.icon} alt="" width={18} height={18} />
        <span className="mono">{shortAddr(connected.address)}</span>
        <span className="wallet-x" aria-label="Disconnect">×</span>
      </button>
    );
  }
  return (
    <div className="wallet-menu">
      <Btn variant="primary" onClick={() => setOpen((o) => !o)} busy={connecting} aria-expanded={open}>Connect wallet</Btn>
      {open && (
        <div className="wallet-list" role="menu">
          {wallets.length === 0 && <p className="muted">No Solana wallet found. Install Phantom, Backpack or Solflare, then reload.</p>}
          {wallets.map((w) => (
            <button key={w.name} role="menuitem" type="button" className="wallet-item"
              onClick={() => { setErr(null); connect(w).then(() => setOpen(false)).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }}>
              <img src={w.icon} alt="" width={22} height={22} />
              {w.name}
            </button>
          ))}
          {err && <p className="field-hint err">{err}</p>}
        </div>
      )}
    </div>
  );
}

export function ConnectPrompt() {
  const { connected } = useWallet();
  if (connected) return <p className="step-help">Connected as <span className="mono">{connected.address}</span> on Solana devnet. This app only ever uses test money.</p>;
  return (
    <>
      <p className="step-help">Use a Phantom, Backpack or Solflare wallet set to <strong>devnet</strong>. No real money is involved.</p>
      <WalletButton />
      <Notice tone="info">Your wallet is only used to sign. Notch never asks for your seed phrase.</Notice>
    </>
  );
}
