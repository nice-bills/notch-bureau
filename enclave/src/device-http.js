// HTTP surface of the device check (shared by http-app.js, cvm-server.js and the demo server):
//   POST /device/nonce      -> the Sign-in-with-Solana payload for the wallet to sign (single use, 5 minutes)
//   x-notch-device header   -> on POST /underwrite: base64(JSON {nonce, signature, signedMessage}) = the wallet's proof
// The signature and signed message are byte arrays or base64. Only the underwriter decides what the proof is worth.
import { DeviceProofError } from './siws.js';

export async function handleDevice(u, req, url, send) {
  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/device/nonce') {
    try {
      send(200, { ok: true, ...u.deviceChallenge() });
    } catch (e) {
      send(e instanceof DeviceProofError ? 429 : 500, { ok: false, reason: e.message });
    }
    return true;
  }
  return false;
}

// -> the proof object, undefined when the header is absent. Throws DeviceProofError on junk (answer 400).
export function deviceProofFrom(req) {
  const raw = req.headers['x-notch-device'];
  if (!raw) return undefined;
  if (String(raw).length > 6000) throw new DeviceProofError('device proof: too large');
  let json;
  try { json = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')); } catch { json = null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new DeviceProofError('device proof: send base64 of {"nonce","signature","signedMessage"}');
  return json;
}

// The HTTP status of a submit() reply: 200 ok, 503 "try again" (RPC outage), 422 refused.
export const statusOf = (r) => (r.ok ? 200 : r.retry ? 503 : 422);
