// Minimal Wallet Standard layer: discovers Phantom, Backpack, Solflare (and any other
// standard wallet), connects, and signs Solana transactions.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features';
import { SolanaSignMessage, SolanaSignTransaction, type SolanaSignMessageFeature, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { address, type Address } from '@solana/kit';
import { CHAIN_ID } from './config';

export interface DetectedWallet {
  wallet: Wallet;
  name: string;
  icon: string;
}

type SolanaWallet = Wallet & {
  features: StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature> & Partial<SolanaSignMessageFeature>;
};

const isSolanaWallet = (w: Wallet): w is SolanaWallet =>
  StandardConnect in w.features && StandardEvents in w.features && SolanaSignTransaction in w.features;

interface WalletState {
  wallets: DetectedWallet[];
  connected: { wallet: DetectedWallet; account: WalletAccount; address: Address } | null;
  connecting: boolean;
  /** True while a remembered wallet is being reconnected silently after a reload (show a skeleton, not the welcome). */
  restoring: boolean;
  connect: (w: DetectedWallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Sign a compiled transaction (wire bytes with empty signatures). Returns the signed wire bytes. */
  signTransaction: (wire: Uint8Array, meta?: { lastValidBlockHeight: bigint }) => Promise<Uint8Array>;
  /** Sign a message (Ed25519 signature bytes). Used to prove you hold the wallet when you send an email to the underwriter. */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

const Ctx = createContext<WalletState | null>(null);

// One app-level session: the wallet's name is remembered, and after a reload the app reconnects silently
// (`connect({ silent: true })` only succeeds if the wallet already trusts this site; it never pops a prompt).
const REMEMBER = 'notch.wallet';
const remembered = () => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };
const remember = (name: string | null) => { try { if (name) localStorage.setItem(REMEMBER, name); else localStorage.removeItem(REMEMBER); } catch { /* private mode */ } };

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [connected, setConnected] = useState<WalletState['connected']>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(() => remembered() !== null);
  const tried = useRef(false);

  useEffect(() => {
    const api = getWallets();
    const sync = () =>
      setWallets(
        api
          .get()
          .filter((w) => isSolanaWallet(w) && w.chains.some((c) => c === CHAIN_ID || c.startsWith('solana:')))
          .map((w) => ({ wallet: w, name: w.name, icon: w.icon })),
      );
    sync();
    const offReg = api.on('register', sync);
    const offUnreg = api.on('unregister', sync);
    return () => {
      offReg();
      offUnreg();
    };
  }, []);

  // Silent reconnect of the remembered wallet, once, as soon as it registers (or give up after a short wait).
  useEffect(() => {
    const name = remembered();
    if (!name || connected || tried.current) { if (!name) setRestoring(false); return; }
    const d = wallets.find((w) => w.name === name);
    if (!d) { const t = setTimeout(() => { if (!tried.current) setRestoring(false); }, 2500); return () => clearTimeout(t); }
    tried.current = true;
    const w = d.wallet as SolanaWallet;
    const existing = w.accounts.find((a) => a.chains.some((c) => c.startsWith('solana:')));
    (existing ? Promise.resolve({ accounts: [existing] }) : w.features[StandardConnect].connect({ silent: true }))
      .then(({ accounts }) => {
        const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
        if (account) setConnected({ wallet: d, account, address: address(account.address) });
      })
      .catch(() => { /* not trusted any more: the user connects again */ })
      .finally(() => setRestoring(false));
  }, [wallets, connected]);

  // Follow account changes made inside the wallet extension.
  useEffect(() => {
    if (!connected) return;
    const w = connected.wallet.wallet as SolanaWallet;
    return w.features[StandardEvents].on('change', ({ accounts }) => {
      if (!accounts) return;
      const next = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:')));
      if (!next) { setConnected(null); remember(null); }
      else setConnected({ wallet: connected.wallet, account: next, address: address(next.address) });
    });
  }, [connected]);

  const connect = useCallback(async (d: DetectedWallet) => {
    setConnecting(true);
    remember(d.name); // a deeplink wallet leaves the page here; on return the silent reconnect picks it up
    try {
      const w = d.wallet as SolanaWallet;
      const { accounts } = await w.features[StandardConnect].connect();
      const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
      if (!account) throw new Error('The wallet did not share an account.');
      remember(d.name);
      setConnected({ wallet: d, account, address: address(account.address) });
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const w = connected?.wallet.wallet as SolanaWallet | undefined;
    setConnected(null);
    remember(null);
    try {
      await w?.features[StandardDisconnect]?.disconnect();
    } catch {
      /* the wallet may not support disconnect; local state is already cleared */
    }
  }, [connected]);

  const signTransaction = useCallback(
    async (wire: Uint8Array, meta?: { lastValidBlockHeight: bigint }) => {
      if (!connected) throw new Error('Connect a wallet first.');
      const w = connected.wallet.wallet as SolanaWallet;
      const [out] = await w.features[SolanaSignTransaction].signTransaction({
        account: connected.account,
        transaction: wire,
        chain: CHAIN_ID,
        ...(meta ? { lastValidBlockHeight: meta.lastValidBlockHeight } : {}), // read only by the Phantom deeplink wallet
      } as Parameters<SolanaWallet['features'][typeof SolanaSignTransaction]['signTransaction']>[0]);
      return out.signedTransaction;
    },
    [connected],
  );

  const signMessage = useCallback(
    async (message: Uint8Array) => {
      if (!connected) throw new Error('Connect a wallet first.');
      const w = connected.wallet.wallet as SolanaWallet;
      const feature = w.features[SolanaSignMessage];
      if (!feature) throw new Error('This wallet cannot sign messages, which Notch needs to know the email is for your wallet. Try Phantom, Backpack or Solflare.');
      const [out] = await feature.signMessage({ account: connected.account, message });
      return out.signature;
    },
    [connected],
  );

  const value = useMemo(
    () => ({ wallets, connected, connecting, restoring: restoring && !connected, connect, disconnect, signTransaction, signMessage }),
    [wallets, connected, connecting, restoring, connect, disconnect, signTransaction, signMessage],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside <WalletProvider>');
  return v;
}
