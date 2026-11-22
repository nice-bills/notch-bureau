// Minimal Wallet Standard layer: discovers Phantom, Backpack, Solflare (and any other
// standard wallet), connects, and signs Solana transactions.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { address, type Address } from '@solana/kit';
import { CHAIN_ID } from './config';

export interface DetectedWallet {
  wallet: Wallet;
  name: string;
  icon: string;
}

type SolanaWallet = Wallet & {
  features: StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature>;
};

const isSolanaWallet = (w: Wallet): w is SolanaWallet =>
  StandardConnect in w.features && StandardEvents in w.features && SolanaSignTransaction in w.features;

interface WalletState {
  wallets: DetectedWallet[];
  connected: { wallet: DetectedWallet; account: WalletAccount; address: Address } | null;
  connecting: boolean;
  connect: (w: DetectedWallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Sign a compiled transaction (wire bytes with empty signatures). Returns the signed wire bytes. */
  signTransaction: (wire: Uint8Array) => Promise<Uint8Array>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [connected, setConnected] = useState<WalletState['connected']>(null);
  const [connecting, setConnecting] = useState(false);

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

  // Follow account changes made inside the wallet extension.
  useEffect(() => {
    if (!connected) return;
    const w = connected.wallet.wallet as SolanaWallet;
    return w.features[StandardEvents].on('change', ({ accounts }) => {
      if (!accounts) return;
      const next = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:')));
      if (!next) setConnected(null);
      else setConnected({ wallet: connected.wallet, account: next, address: address(next.address) });
    });
  }, [connected]);

  const connect = useCallback(async (d: DetectedWallet) => {
    setConnecting(true);
    try {
      const w = d.wallet as SolanaWallet;
      const { accounts } = await w.features[StandardConnect].connect();
      const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
      if (!account) throw new Error('The wallet did not share an account.');
      setConnected({ wallet: d, account, address: address(account.address) });
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const w = connected?.wallet.wallet as SolanaWallet | undefined;
    setConnected(null);
    try {
      await w?.features[StandardDisconnect]?.disconnect();
    } catch {
      /* the wallet may not support disconnect; local state is already cleared */
    }
  }, [connected]);

  const signTransaction = useCallback(
    async (wire: Uint8Array) => {
      if (!connected) throw new Error('Connect a wallet first.');
      const w = connected.wallet.wallet as SolanaWallet;
      const [out] = await w.features[SolanaSignTransaction].signTransaction({
        account: connected.account,
        transaction: wire,
        chain: CHAIN_ID,
      });
      return out.signedTransaction;
    },
    [connected],
  );

  const value = useMemo(
    () => ({ wallets, connected, connecting, connect, disconnect, signTransaction }),
    [wallets, connected, connecting, connect, disconnect, signTransaction],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside <WalletProvider>');
  return v;
}
