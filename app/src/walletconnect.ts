// The "WalletConnect" Wallet Standard wallet: a tiny stub in the main bundle. The WalletConnect code itself (Reown
// AppKit + the universal provider) is a separate chunk, downloaded only when the user taps it or signs with it.
// The connected address is remembered, so the app-wide silent reconnect works without downloading anything.
import { getWallets } from '@wallet-standard/app';
import { address } from '@solana/kit';
import { CHAIN_ID, WC_PROJECT_ID } from './config';
import { unb58 } from './wc-sign';

export const WC_NAME = 'WalletConnect';
const K_ADDR = 'notch.wc.address';
const read = () => { try { return localStorage.getItem(K_ADDR); } catch { return null; } };
const write = (v: string | null) => { try { if (v) localStorage.setItem(K_ADDR, v); else localStorage.removeItem(K_ADDR); } catch { /* private mode */ } };

/** Only with a project id (VITE_WC_PROJECT_ID). Without one the option is simply not there. */
export const wcEnabled = () => !!WC_PROJECT_ID;
const load = () => import('./wc-session');

const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3B99FC"/><path d="M9.6 12.4c3.5-3.4 9.3-3.4 12.8 0l.4.4a.4.4 0 0 1 0 .6l-1.5 1.4a.2.2 0 0 1-.3 0l-.6-.6a6.2 6.2 0 0 0-8.8 0l-.6.6a.2.2 0 0 1-.3 0l-1.5-1.4a.4.4 0 0 1 0-.6zm15.9 2.9 1.3 1.3a.4.4 0 0 1 0 .6l-6 5.9a.4.4 0 0 1-.6 0l-4.2-4.2a.1.1 0 0 0-.2 0l-4.2 4.2a.4.4 0 0 1-.6 0l-6-5.9a.4.4 0 0 1 0-.6l1.3-1.3a.4.4 0 0 1 .6 0l4.2 4.2a.1.1 0 0 0 .2 0l4.2-4.2a.4.4 0 0 1 .6 0l4.2 4.2a.1.1 0 0 0 .2 0l4.2-4.2a.4.4 0 0 1 .6 0z" fill="#fff"/></svg>');

export function registerWalletConnect() {
  if (!wcEnabled()) return;
  const listeners = new Set<(p: { accounts?: unknown[] }) => void>();
  const account = () => {
    const a = read();
    return a ? { address: a, publicKey: unb58(a), chains: [CHAIN_ID], features: ['solana:signTransaction', 'solana:signMessage'] as const } : null;
  };
  const forget = () => { write(null); listeners.forEach((l) => l({ accounts: [] })); };
  const wallet = {
    version: '1.0.0' as const,
    name: WC_NAME,
    icon: ICON as `data:image/svg+xml;base64,${string}`,
    chains: [CHAIN_ID] as `${string}:${string}`[],
    get accounts() { const a = account(); return a ? [a] : []; },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: { silent?: boolean }) => {
          const a = account();
          if (a) return { accounts: [a] };
          if (input?.silent) return { accounts: [] };
          const addr = await (await load()).connect();
          write(addr);
          return { accounts: [account()!] };
        },
      },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { const had = read(); forget(); if (had) await (await load()).disconnect(); } },
      'standard:events': { version: '1.0.0', on: (_e: string, l: (p: { accounts?: unknown[] }) => void) => { listeners.add(l); return () => listeners.delete(l); } },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const who = read();
          if (!who) throw new Error('Connect your wallet first.');
          const m = await load();
          if (!(await m.restore())) { forget(); throw new Error('The WalletConnect session ended. Connect your wallet again.'); }
          return [{ signedTransaction: await m.signTransaction(inputs[0].transaction, address(who)) }];
        },
      },
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const who = read();
          if (!who) throw new Error('Connect your wallet first.');
          const m = await load();
          if (!(await m.restore())) { forget(); throw new Error('The WalletConnect session ended. Connect your wallet again.'); }
          return [{ signedMessage: inputs[0].message, signature: await m.signMessage(inputs[0].message, who) }];
        },
      },
    },
  };
  getWallets().register(wallet as never);
}
