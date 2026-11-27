// Phantom deeplinks, for a phone browser that has no wallet inside it (iPhone Safari/Chrome).
// https://docs.phantom.com/phantom-deeplinks
//
// The page sends the user to the Phantom app with an encrypted request, and Phantom sends them back to `redirect_link`
// with an encrypted answer. That reloads this page, so nothing in memory survives the trip:
//   - the session (our X25519 key, Phantom's key, the session token, the address) lives in localStorage;
//   - a signed TRANSACTION comes back as a pending result that App broadcasts on return (see resumeFromPhantom);
//   - a signed MESSAGE is kept until the screen that asked for it picks it up (takeSignedMessage).
// The wallet is registered as a normal Wallet Standard wallet, so the sign-in sheet and useWallet() need no special path.
import nacl from 'tweetnacl';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { getWallets } from '@wallet-standard/app';
import { CHAIN_ID } from './config';

export const PHANTOM_LINK_NAME = 'Phantom app';
const BASE = 'https://phantom.app/ul/v1';
const K_SESSION = 'notch.phantom.session';
const K_PENDING = 'notch.phantom.pending';
const K_RESULT = 'notch.phantom.result';

const b58 = (u: Uint8Array) => getBase58Decoder().decode(u);
const unb58 = (s: string) => new Uint8Array(getBase58Encoder().encode(s));
const toB64 = (u: Uint8Array) => btoa(Array.from(u, (b) => String.fromCharCode(b)).join(''));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Session { secret: string; phantomPub?: string; session?: string; address?: string }
export type Pending =
  | { kind: 'connect' }
  | { kind: 'tx'; lastValidBlockHeight: string }
  | { kind: 'msg'; message: string };
export type Outcome =
  | { kind: 'connect'; address: string }
  | { kind: 'tx'; signed: string; lastValidBlockHeight: string }
  | { kind: 'msg'; message: string; signature: string }
  | { kind: 'error'; action: Pending['kind'] | 'unknown'; message: string };

const read = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function session(): Session {
  let s = read<Session>(K_SESSION);
  if (!s) { s = { secret: b58(nacl.box.keyPair().secretKey) }; write(K_SESSION, s); }
  return s;
}
const dappKeys = (s: Session) => nacl.box.keyPair.fromSecretKey(unb58(s.secret));
const shared = (s: Session, phantomPub: string) => nacl.box.before(unb58(phantomPub), dappKeys(s).secretKey);

export const linkedAddress = () => read<Session>(K_SESSION)?.address ?? null;
export const forgetPhantomLink = () => { write(K_SESSION, null); write(K_PENDING, null); write(K_RESULT, null); };

function redirectLink(action: string): string {
  const u = new URL(location.href);
  u.searchParams.set('phantom', action);
  return u.toString();
}

function go(path: string, params: Record<string, string>, pending: Pending): Promise<never> {
  write(K_PENDING, pending);
  location.assign(`${BASE}/${path}?${new URLSearchParams(params)}`);
  return new Promise<never>(() => {}); // the page is leaving; the answer arrives on the next load
}

function encryptedRequest(s: Session, payload: Record<string, string>) {
  if (!s.phantomPub || !s.session) throw new Error('Connect Phantom first.');
  const nonce = nacl.randomBytes(24);
  const box = nacl.box.after(new TextEncoder().encode(JSON.stringify({ ...payload, session: s.session })), nonce, shared(s, s.phantomPub));
  return { dapp_encryption_public_key: b58(dappKeys(s).publicKey), nonce: b58(nonce), payload: b58(box) };
}

export function connectPhantom(): Promise<never> {
  const s = session();
  return go('connect', {
    app_url: location.origin,
    dapp_encryption_public_key: b58(dappKeys(s).publicKey),
    cluster: CHAIN_ID.split(':')[1] || 'devnet',
    redirect_link: redirectLink('connect'),
  }, { kind: 'connect' });
}

export function signTransactionInPhantom(wire: Uint8Array, lastValidBlockHeight: bigint): Promise<never> {
  const s = session();
  return go('signTransaction', { ...encryptedRequest(s, { transaction: b58(wire) }), redirect_link: redirectLink('tx') }, { kind: 'tx', lastValidBlockHeight: String(lastValidBlockHeight) });
}

export function signMessageInPhantom(message: Uint8Array): Promise<never> {
  const s = session();
  return go('signMessage', { ...encryptedRequest(s, { message: b58(message), display: 'utf8' }), redirect_link: redirectLink('msg') }, { kind: 'msg', message: toB64(message) });
}

/** What this page load came back from Phantom with (screens use it to show the result, not the form). */
export let returnedWith: Outcome['kind'] | null = null;

/** On page load: read Phantom's answer from the URL (if any), store the outcome, clean the URL. */
export function consumePhantomRedirect(): Outcome | null {
  const u = new URL(location.href);
  const action = u.searchParams.get('phantom');
  if (!action) return null;
  const p = new URLSearchParams(u.searchParams);
  const pending = read<Pending>(K_PENDING);
  write(K_PENDING, null);
  for (const k of ['phantom', 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage']) u.searchParams.delete(k);
  history.replaceState(history.state, '', u.toString());

  let out: Outcome;
  const kind = (pending?.kind ?? 'unknown') as Pending['kind'] | 'unknown';
  if (p.get('errorCode')) {
    const code = p.get('errorCode');
    if (code === '4001') out = { kind: 'error', action: kind, message: 'You cancelled in Phantom. Nothing was signed.' };
    else {
      // Any other refusal ("Unexpected error", unauthorized, disconnected) almost always means Phantom no longer knows this
      // page's link: another account is active, or the app was reset. Drop the link so the next tap connects afresh.
      forgetPhantomLink();
      out = { kind: 'error', action: kind, message: `Phantom lost the link to this page (${p.get('errorMessage') || `error ${code}`}). Connect Phantom again, then try once more.` };
    }
  } else if (!pending || pending.kind !== action) {
    out = { kind: 'error', action: kind, message: 'Phantom sent back an answer this page was not waiting for. Try again.' };
  } else {
    try {
      const s = session();
      const phantomPub = action === 'connect' ? p.get('phantom_encryption_public_key') ?? '' : s.phantomPub ?? '';
      const opened = nacl.box.open(unb58(p.get('data') ?? ''), unb58(p.get('nonce') ?? ''), unb58(phantomPub), dappKeys(s).secretKey);
      if (!opened) throw new Error('could not decrypt');
      const data = JSON.parse(new TextDecoder().decode(opened)) as Record<string, string>;
      if (pending.kind === 'connect') {
        write(K_SESSION, { ...s, phantomPub, session: data.session, address: data.public_key });
        out = { kind: 'connect', address: data.public_key };
      } else if (pending.kind === 'tx') {
        out = { kind: 'tx', signed: toB64(unb58(data.transaction)), lastValidBlockHeight: pending.lastValidBlockHeight };
      } else {
        out = { kind: 'msg', message: pending.message, signature: toB64(unb58(data.signature)) };
      }
    } catch {
      out = { kind: 'error', action: kind, message: 'Phantom’s answer could not be read. Connect Phantom again.' };
      if (kind === 'connect') forgetPhantomLink();
    }
  }
  write(K_RESULT, out);
  returnedWith = out.kind;
  return out;
}

/** A message Phantom signed on the last trip, if `match` accepts it (consumed once). */
export function takeSignedMessage(match: (message: string) => boolean): { message: string; signature: Uint8Array } | null {
  const r = read<Outcome>(K_RESULT);
  if (!r || r.kind !== 'msg') return null;
  const message = new TextDecoder().decode(fromB64(r.message));
  if (!match(message)) return null;
  write(K_RESULT, null);
  return { message, signature: fromB64(r.signature) };
}
/** A transaction Phantom signed on the last trip, waiting to be sent (consumed once). */
export function takeSignedTransaction(): { signed: Uint8Array; lastValidBlockHeight: bigint } | null {
  const r = read<Outcome>(K_RESULT);
  if (!r || r.kind !== 'tx') return null;
  write(K_RESULT, null);
  return { signed: fromB64(r.signed), lastValidBlockHeight: BigInt(r.lastValidBlockHeight) };
}
export function takeError(): string | null {
  const r = read<Outcome>(K_RESULT);
  if (!r || r.kind !== 'error') return null;
  write(K_RESULT, null);
  return r.message;
}

const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#AB9FF2"/><path d="M8 22c0-6 3-11 8-11s8 5 8 11h-4c0-3-1-6-4-6s-4 3-4 6z" fill="#fff"/></svg>');

/** Register the deeplink wallet (call only where no wallet lives in the browser: a phone browser). */
export function registerPhantomLink() {
  const listeners = new Set<(p: { accounts?: unknown[] }) => void>();
  const account = () => {
    const a = linkedAddress();
    return a ? { address: a, publicKey: unb58(a), chains: [CHAIN_ID], features: ['solana:signTransaction', 'solana:signMessage'] as const } : null;
  };
  const wallet = {
    version: '1.0.0' as const,
    name: PHANTOM_LINK_NAME,
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
          return connectPhantom();
        },
      },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { forgetPhantomLink(); listeners.forEach((l) => l({ accounts: [] })); } },
      'standard:events': { version: '1.0.0', on: (_e: string, l: (p: { accounts?: unknown[] }) => void) => { listeners.add(l); return () => listeners.delete(l); } },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        // The caller passes `lastValidBlockHeight` through the wire's side channel (see chain.ts sendTransaction).
        signTransaction: async (...inputs: { transaction: Uint8Array; lastValidBlockHeight?: bigint }[]) =>
          signTransactionInPhantom(inputs[0].transaction, inputs[0].lastValidBlockHeight ?? 0n),
      },
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const want = new TextDecoder().decode(inputs[0].message);
          const done = takeSignedMessage((m) => m === want);
          if (done) return [{ signedMessage: inputs[0].message, signature: done.signature }];
          return signMessageInPhantom(inputs[0].message);
        },
      },
    },
  };
  getWallets().register(wallet as never);
}
