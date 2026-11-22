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

/** Send a raw .eml to the sealed underwriter. Only the signed limit comes back. */
export async function underwrite(eml: Uint8Array, wallet: string): Promise<EnclaveResult> {
  let r: Response;
  try {
    r = await fetch(`${ENCLAVE_URL}/underwrite`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-wallet': wallet },
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
