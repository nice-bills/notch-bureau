// POST /underwrite: the DIRECT path. It takes only the sources that carry no identity (Deel, bank, Superteam Earn ...): a mobile-money
// statement is refused by Underwriter.submit unless it came through the statement inbox (audit #3). On this path the caller must
// PROVE they hold the wallet they ask a limit for, and bind the proof to this very email:
//
//   x-wallet     the borrower's address (base58)
//   x-notch-ts   milliseconds since the epoch (within 10 minutes of the server's clock)
//   x-notch-sig  base64 Ed25519 signature by that wallet over   notch-underwrite-v1|<wallet>|<sha256 hex of the raw email bytes>|<ts>
//
// Without it anybody could submit anybody's email for any wallet, and a stolen email could be redirected to another wallet. The
// signature is over the email hash, so it cannot be replayed with a different email. Replaying the same signed request is
// harmless: the email's dedupe hash is spent on the first success.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { deviceProofFrom, statusOf } from './device-http.js';

const MAX = 5 * 1024 * 1024;
const MAX_SKEW_MS = 10 * 60_000;

export const emlSha256 = (eml) => crypto.createHash('sha256').update(eml).digest('hex');
export const underwriteMessage = (wallet, emlHash, ts) => `notch-underwrite-v1|${wallet}|${emlHash}|${ts}`;

/** The headers a client sends: sign with the wallet's secret key (64 bytes, tweetnacl). */
export function signUnderwrite({ wallet, eml, secretKey, ts = Date.now() }) {
  const sig = nacl.sign.detached(Buffer.from(underwriteMessage(wallet, emlSha256(eml), ts)), secretKey);
  return { 'x-wallet': wallet, 'x-notch-ts': String(ts), 'x-notch-sig': Buffer.from(sig).toString('base64') };
}

export function verifyUnderwriteSig({ wallet, eml, ts, signature, now = Date.now() }) {
  try {
    const age = Math.abs(now - Number(ts));
    if (!Number.isFinite(age) || age > MAX_SKEW_MS) return false;
    const sig = Buffer.from(String(signature || ''), 'base64');
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(Buffer.from(underwriteMessage(wallet, emlSha256(eml), ts)), sig, bs58.decode(wallet));
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Returns true when the request was POST /underwrite (and has been answered).
// `insecureAllowUnsignedForTests`: TEST ONLY (an in-process e2e server). No real server sets it.
export async function handleUnderwrite(u, req, url, send, { now = () => Date.now(), insecureAllowUnsignedForTests = false } = {}) {
  if (!(req.method === 'POST' && url.pathname === '/underwrite')) return false;
  const wallet = String(req.headers['x-wallet'] || '');
  try {
    if (bs58.decode(wallet).length !== 32) throw new Error('length');
  } catch {
    send(400, { ok: false, reason: 'x-wallet header must be a base58 address' });
    return true;
  }
  let device;
  try { device = deviceProofFrom(req); } catch (e) { send(400, { ok: false, reason: e.message }); return true; }
  const eml = await readBody(req);
  if (!eml) { send(413, { ok: false, reason: 'email too large' }); return true; }
  if (!insecureAllowUnsignedForTests
    && !verifyUnderwriteSig({ wallet, eml, ts: req.headers['x-notch-ts'], signature: req.headers['x-notch-sig'], now: now() })) {
    send(401, { ok: false, reason: 'sign the request with your wallet: x-notch-ts and x-notch-sig (Ed25519 over "notch-underwrite-v1|<wallet>|<sha256 of the email>|<ts>") are missing, stale or wrong' });
    return true;
  }
  try {
    const r = await u.submit(eml, wallet, { device });
    send(statusOf(r), r);
  } catch (e) {
    send(500, { ok: false, reason: e.message });
  }
  return true;
}
