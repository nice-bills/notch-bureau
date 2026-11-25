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
