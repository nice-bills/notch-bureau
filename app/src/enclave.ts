import { ENCLAVE_URL } from './config';
import { explainEnclaveReason } from './errors';
import { base64ToBytes } from './notch';

export interface EnclaveOk {
  ok: true;
  extraction: string;
  limitUsdc: number;
  expiry: number;
  nonce: string;
  /** base64 of the 96 byte record the underwriter signed */
  message: string;
  /** base64 ed25519 signature over `message` */
  signature: string;
}
export interface EnclaveRefusal {
  ok: false;
  reason: string;
  friendly: string;
}
export type EnclaveResult = EnclaveOk | EnclaveRefusal;

export interface Attestation {
  underwriter: string;
  mode: string;
  extraction?: { mode: string; model?: string };
  note?: string;
}

export async function getAttestation(signal?: AbortSignal): Promise<Attestation> {
  const r = await fetch(`${ENCLAVE_URL}/attestation`, { signal });
  if (!r.ok) throw new Error(`Underwriter answered HTTP ${r.status}`);
  return r.json();
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** What the wallet signs to say "this email is for me": wallet, the email's SHA-256 and the time. Same text the underwriter checks. */
export const underwriteMessage = (wallet: string, emlSha256Hex: string, ts: number) => `notch-underwrite-v1|${wallet}|${emlSha256Hex}|${ts}`;

/**
 * Send a raw .eml to the sealed underwriter. Only the signed limit comes back.
 * `signMessage` is the connected wallet's: the underwriter wants proof that you hold the wallet the limit is for, so nobody
 * can send your email for another wallet. Without it the request is refused (HTTP 401).
 */
export async function underwrite(eml: Uint8Array, wallet: string, signMessage?: (m: Uint8Array) => Promise<Uint8Array>): Promise<EnclaveResult> {
  let r: Response;
  const headers: Record<string, string> = { 'content-type': 'message/rfc822', 'x-wallet': wallet };
  if (signMessage) {
    const ts = Date.now();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', eml as BufferSource));
    const sig = await signMessage(new TextEncoder().encode(underwriteMessage(wallet, hex(digest), ts)));
    headers['x-notch-ts'] = String(ts);
    headers['x-notch-sig'] = toB64(sig);
  }
  try {
    r = await fetch(`${ENCLAVE_URL}/underwrite`, {
      method: 'POST',
      headers,
      body: eml as BodyInit,
    });
  } catch {
    throw new Error(`Failed to fetch the underwriter at ${ENCLAVE_URL}. Is it running?`);
  }
  let body: { ok?: boolean; reason?: string } & Partial<EnclaveOk>;
  try {
    body = await r.json();
  } catch {
    throw new Error(`Underwriter answered HTTP ${r.status} with something unreadable.`);
  }
  if (!r.ok || !body.ok) {
    const reason = body.reason ?? `HTTP ${r.status}`;
    return { ok: false, reason, friendly: explainEnclaveReason(reason) };
  }
  return body as EnclaveOk;
}

export const recordBytes = (r: EnclaveOk) => base64ToBytes(r.message);
export const signatureBytes = (r: EnclaveOk) => base64ToBytes(r.signature);

// ---- The statement inbox -------------------------------------------------------------------------------------------
// A MoMo statement only counts when the provider emails it to the wallet's own inbox address (the DKIM-signed To must
// name it). `POST /inbox/new` hands out that address and a poll token; `GET /record/<wallet>` answers with the result.

export interface InboxAddress {
  address: string;
  pollToken: string;
  expiresAt: string;
  /** false: the underwriter has no real mail domain yet, so only the demo delivery can reach this address. */
  domainConfigured: boolean;
  /** true when the underwriter writes the public status rows (Supabase) the phone can watch live. */
  liveStatus: boolean;
}
export type RecordPoll =
  | { status: 'waiting' }
  | { status: 'ready'; result: EnclaveOk }
  | { status: 'refused' | 'locked'; reason: string; friendly: string };

async function readJson(r: Response): Promise<Record<string, unknown>> {
  try {
    return await r.json();
  } catch {
    throw new Error(`The sealed computer answered HTTP ${r.status} with something unreadable.`);
  }
}
async function call(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${ENCLAVE_URL}${path}`, init);
  } catch {
    throw new Error(`Could not reach the sealed computer at ${ENCLAVE_URL}. Check your connection, or start it with "pnpm demo:enclave".`);
  }
}

/** What the wallet signs to ask for an inbox address: same text the underwriter checks. */
export const inboxMessage = (wallet: string, ts: number) => `notch-inbox-v1|${wallet}|${ts}`;

/**
 * Ask for this wallet's statement address. Proof of the wallet is either a Supabase "Sign in with Solana" token
 * (`bearer`) or a signature over `notch-inbox-v1|wallet|ts`.
 */
export async function newInbox(wallet: string, proof: { bearer: string } | { signMessage: (m: Uint8Array) => Promise<Uint8Array> }): Promise<InboxAddress> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const body: Record<string, unknown> = { wallet };
  if ('bearer' in proof) headers.authorization = `Bearer ${proof.bearer}`;
  else {
    const ts = Date.now();
    body.ts = ts;
    body.signature = toB64(await proof.signMessage(new TextEncoder().encode(inboxMessage(wallet, ts))));
  }
  const r = await call('/inbox/new', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await readJson(r);
  if (r.status === 404) throw new Error('This sealed computer has no statement inbox. Restart it with the latest "pnpm demo:enclave".');
  if (!r.ok || !j.ok) throw new Error(explainEnclaveReason(String(j.reason ?? `HTTP ${r.status}`)));
  return j as unknown as InboxAddress;
}

/** One poll of the result for this wallet's inbox. */
export async function pollRecord(wallet: string, pollToken: string, signal?: AbortSignal): Promise<RecordPoll> {
  let r: Response;
  try {
    r = await fetch(`${ENCLAVE_URL}/record/${wallet}`, { headers: { 'x-notch-token': pollToken }, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('Lost touch with the sealed computer. Retrying…');
  }
  const j = await readJson(r);
  if (r.status === 404) throw new Error('This inbox address is no longer known (it expired, or the sealed computer restarted). Ask for a new one.');
  if (!r.ok) throw new Error(explainEnclaveReason(String(j.reason ?? `HTTP ${r.status}`)));
  if (j.status === 'ready') {
    const { status: _s, ...rest } = j;
    void _s;
    return { status: 'ready', result: rest as unknown as EnclaveOk };
  }
  if (j.status === 'refused' || j.status === 'locked') {
    const reason = String(j.reason ?? 'refused');
    return { status: j.status, reason, friendly: j.status === 'locked' ? 'This address refused too many emails and is now locked. Ask for a new one.' : explainEnclaveReason(reason) };
  }
  return { status: 'waiting' };
}

/** DEMO ONLY (the local demo underwriter): email a synthetic, freshly signed MoMo statement to this inbox address. */
export async function demoDeliver(address: string): Promise<void> {
  const r = await call('/demo/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
  if (r.status === 404) throw new Error('This sealed computer has no demo mailer. Only the local demo underwriter can send a sample statement.');
  const j = await readJson(r);
  if (!r.ok && !j.reason) throw new Error(`HTTP ${r.status}`);
  // A refusal (422) is a real answer: the poll shows it in plain words.
  if (!r.ok && r.status !== 422) throw new Error(explainEnclaveReason(String(j.reason)));
}

/** Tell the underwriter which devnet transaction posted the record (links the public status row). Best effort. */
export async function reportPosted(signature: string): Promise<void> {
  try {
    await fetch(`${ENCLAVE_URL}/posted`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
  } catch {
    /* only a convenience for the public status; the limit is already on chain */
  }
}
