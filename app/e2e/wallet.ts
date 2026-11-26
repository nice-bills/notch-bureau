// A Wallet Standard wallet for the browser tests.
//
// The page gets an init script that registers a wallet with the standard connect / events / disconnect and
// solana:signTransaction / solana:signAndSendTransaction features, the same way Phantom does. Signing happens
// in Node (`context.exposeFunction`): the secret key never exists in page JavaScript, only the public address.
import nacl from 'tweetnacl';
import type { BrowserContext } from '@playwright/test';
import { address, getAddressDecoder, getTransactionDecoder, getTransactionEncoder, createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import { WALLET_NAME } from './env.ts';
import { rpcSend } from './chain.ts';

export interface TestWallet {
  address: string;
  secretKey: Uint8Array; // 64 bytes (seed + public key), held in Node only
  signer: KeyPairSigner;
  /** How many transactions the wallet was asked to sign (the app must not ask for dry runs). */
  signCount: number;
  /** How many messages the wallet was asked to sign (the underwriter wants a signature over each email). */
  messageCount?: number;
}

export async function newWallet(): Promise<TestWallet> {
  const kp = nacl.sign.keyPair();
  const addr = getAddressDecoder().decode(kp.publicKey);
  return { address: addr, secretKey: kp.secretKey, signer: await createKeyPairSignerFromBytes(kp.secretKey), signCount: 0 };
}

const ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ab9ff2"/><path d="M8 22c0-6 3-11 8-11s8 5 8 11h-4c0-3-1-6-4-6s-4 3-4 6z" fill="#fff"/></svg>',
  ).toString('base64');

/** Sign a wire transaction with the wallet key. Returns the signed wire bytes. */
export function signWire(w: TestWallet, wire: Uint8Array): Uint8Array {
  const tx = getTransactionDecoder().decode(wire);
  if (!(w.address in tx.signatures)) throw new Error(`test wallet ${w.address} is not a required signer of this transaction`);
  const sig = nacl.sign.detached(new Uint8Array(tx.messageBytes), w.secretKey);
  return new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [address(w.address)]: sig as never } }));
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** Install the wallet into a browser context (every page, every reload). */
export async function installWallet(context: BrowserContext, w: TestWallet): Promise<void> {
  await context.exposeFunction('__e2eSign', (wireB64: string) => {
    w.signCount++;
    return b64(signWire(w, new Uint8Array(Buffer.from(wireB64, 'base64'))));
  });
  await context.exposeFunction('__e2eSignAndSend', async (wireB64: string) => {
    w.signCount++;
    const signed = signWire(w, new Uint8Array(Buffer.from(wireB64, 'base64')));
    return await rpcSend('sendTransaction', [b64(signed), { encoding: 'base64', skipPreflight: true }]) as string;
  });
  await context.exposeFunction('__e2eSignMessage', (msgB64: string) => {
    w.messageCount = (w.messageCount ?? 0) + 1;
    return b64(nacl.sign.detached(new Uint8Array(Buffer.from(msgB64, 'base64')), w.secretKey));
  });
  await context.addInitScript(walletScript, { addr: w.address, name: WALLET_NAME, icon: ICON });
}

// Runs in the page. Plain JS, no imports: it is serialised into the browser.
function walletScript({ addr, name, icon }: { addr: string; name: string; icon: string }) {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const fromBase58 = (s: string) => {
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
    const out: number[] = [];
    while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const c of s) { if (c === '1') out.unshift(0); else break; }
    return new Uint8Array(out);
  };
  const toB64 = (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const w = window as unknown as Record<string, (x: string) => Promise<string>> & Record<string, unknown>;

  const account = Object.freeze({
    address: addr,
    publicKey: fromBase58(addr),
    chains: ['solana:devnet', 'solana:mainnet', 'solana:testnet'],
    features: ['solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage'],
    label: 'E2E account',
  });
  let connected = false;
  const listeners = new Set<(p: unknown) => void>();
  const emit = () => listeners.forEach((l) => l({ accounts: connected ? [account] : [] }));

  const wallet = {
    version: '1.0.0',
    name,
    icon,
    chains: ['solana:devnet', 'solana:mainnet', 'solana:testnet'],
    get accounts() { return connected ? [account] : []; },
    features: {
      // Like Phantom: a silent connect succeeds only once the user has approved this site (remembered across reloads).
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: { silent?: boolean }) => {
          if (input?.silent && localStorage.getItem('__e2e_trusted') !== '1') return { accounts: [] };
          connected = true; localStorage.setItem('__e2e_trusted', '1'); emit(); return { accounts: [account] };
        },
      },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; localStorage.removeItem('__e2e_trusted'); emit(); } },
      'standard:events': {
        version: '1.0.0',
        on: (_e: string, l: (p: unknown) => void) => { listeners.add(l); return () => listeners.delete(l); },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedTransaction: fromB64(await w.__e2eSign(toB64(i.transaction))) }))),
      },
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: fromB64(await w.__e2eSignMessage(toB64(i.message))) }))),
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signature: fromBase58(await w.__e2eSignAndSend(toB64(i.transaction))) }))),
      },
    },
  };

  const register = (api: { register: (x: unknown) => void }) => api.register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch { /* app not listening yet */ }
  window.addEventListener('wallet-standard:app-ready', ((e: CustomEvent) => register(e.detail)) as EventListener);
}
