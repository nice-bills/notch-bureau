// Sign-in-with-Solana (SIWS) for the device check: the FIRST half of "one phone = one borrower". It proves the user holds
// the wallet's private key right now; src/sgt.js is the second half (that wallet holds a Seeker Genesis Token).
// Both are required. Doing only the second lets anyone submit a Seeker owner's public address and pass.
//
// Follows the SKILL.md of solana-mobile/solana-mobile-skills (seeker-genesis-token):
//   * the underwriter issues the WHOLE payload (domain, uri, statement, chainId, nonce, times), single use, short life,
//     because every field the client chooses is a field an attacker chooses;
//   * chainId is pinned to solana:mainnet (SGTs exist only on mainnet: a signature scoped to devnet proves nothing);
//   * the verifying key is derived from the wallet the underwriter is about to act on, NEVER taken from the request:
//     verifySignIn does not check that a supplied key matches the address, so a throwaway key could "sign for" any address;
//   * the nonce is consumed atomically (Map.delete is synchronous) before anything else is checked.
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { createSignInMessage, verifySignIn } from '@solana/wallet-standard-util';

export class DeviceProofError extends Error {}

// What a wallet signs: the issued payload plus its own address (the same bytes Wallet Standard's signIn produces).
// Used by tests and scripts that play the wallet; the real wallet app does this itself.
export const deviceMessage = (issued, address) => createSignInMessage({ ...issued, address });

const NONCE_TTL_MS = 5 * 60_000;

export class DeviceNonces {
  constructor({
    domain = process.env.NOTCH_SIWS_DOMAIN || 'notch.credit',
    uri = process.env.NOTCH_SIWS_URI || `https://${process.env.NOTCH_SIWS_DOMAIN || 'notch.credit'}`,
    statement = 'Sign in to Notch to link this phone to your credit line',
    ttlMs = NONCE_TTL_MS,
    max = 5000,
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { domain, uri, statement, ttlMs, max, now });
    this.open = new Map(); // nonce -> { payload, expires }
  }

  // -> the payload the client must pass to signIn (it adds `address` itself).
  issue() {
    const t = this.now();
    for (const [n, e] of this.open) if (e.expires <= t) this.open.delete(n);
    if (this.open.size >= this.max) throw new DeviceProofError('too many open device challenges, try again in a minute');
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = {
      chainId: 'solana:mainnet',
      domain: this.domain,
      expirationTime: new Date(t + this.ttlMs).toISOString(),
      issuedAt: new Date(t).toISOString(),
      nonce,
      statement: this.statement,
      uri: this.uri,
      version: '1',
    };
    this.open.set(nonce, { payload, expires: t + this.ttlMs });
    return payload;
  }

  // Single use. -> payload | null (unknown, already used, or expired)
  consume(nonce) {
    const e = this.open.get(String(nonce));
    this.open.delete(String(nonce));
    if (!e || e.expires <= this.now()) return null;
    return e.payload;
  }
}

const bytes = (v, what, len) => {
  let b;
  if (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) b = Uint8Array.from(v);
  else if (typeof v === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v)) b = Uint8Array.from(Buffer.from(v, 'base64'));
  else throw new DeviceProofError(`device proof: malformed ${what}`);
  if (len && b.length !== len) throw new DeviceProofError(`device proof: malformed ${what}`);
  return b;
};

// proof = { nonce, signature, signedMessage }  (signature/signedMessage: byte arrays or base64). `wallet` is the address
// the underwriter will act on; the signature must be that wallet's. Consumes the nonce. Throws DeviceProofError.
export function verifyDeviceProof(nonces, wallet, proof) {
  if (!proof || typeof proof !== 'object') throw new DeviceProofError('device proof: missing');
  // shape first: every one of these values is attacker-chosen
  const signature = bytes(proof.signature, 'signature', 64);
  const signedMessage = bytes(proof.signedMessage, 'signed message');
  if (signedMessage.length > 2048) throw new DeviceProofError('device proof: malformed signed message');
  let publicKey;
  try { publicKey = bs58.decode(String(wallet)); } catch { throw new DeviceProofError('device proof: malformed address'); }
  if (publicKey.length !== 32) throw new DeviceProofError('device proof: malformed address');

  const issued = nonces.consume(proof.nonce);
  if (!issued) throw new DeviceProofError('device proof: the challenge is unknown, already used or expired; ask for a new one');
  if (Date.parse(issued.expirationTime) <= nonces.now()) throw new DeviceProofError('device proof: the challenge expired; ask for a new one');
  let ok = false;
  try {
    ok = verifySignIn(
      { ...issued, address: String(wallet) },
      { account: { address: String(wallet), chains: [], features: [], publicKey }, signature, signedMessage },
    );
  } catch { ok = false; }
  if (!ok) throw new DeviceProofError('device proof: the signature does not match this wallet and challenge');
}
