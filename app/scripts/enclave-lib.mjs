// Shared demo-underwriter pieces: the Underwriter (same class as the real enclave) wired to the
// synthetic DKIM fixtures, plus the tiny HTTP server in front of it. Used by demo-enclave.mjs
// (the long-running demo server) and e2e-devnet.mjs (which runs its own copy on a random port so it
// can sign fresh emails: the fixtures' DKIM key lives in the process that imports them).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import bs58 from 'bs58';
import { Underwriter, DEFAULT_TRUSTED } from '../../enclave/src/underwriter.js';
import * as fixtures from '../../enclave/test/fixtures/emails.js';

export { fixtures };

/** Underwriter keyed from `keyFile` (created if missing; omit for a throwaway in-memory key). */
export function makeUnderwriter(keyFile, { llm = null, ...extra } = {}) {
  let secretKey;
  if (keyFile && fs.existsSync(keyFile)) secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, 'utf8')));
  const u = new Underwriter({ secretKey, resolver: fixtures.resolver, trusted: [...DEFAULT_TRUSTED, 'bank.test'], llm, ...extra });
  if (keyFile && !secretKey) fs.writeFileSync(keyFile, JSON.stringify(Array.from(u.keys.secretKey)), { mode: 0o600 });
  return u;
}

/** The HTTP surface of the underwriter. Reply shapes come straight from Underwriter.submit(). */
export function makeServer(u) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-wallet' }); return res.end(); }
    if (req.method === 'GET' && req.url === '/attestation') {
      return send(200, { underwriter: u.publicKey, mode: 'local-dev', extraction: u.llm ? { mode: 'llm', model: u.llm.model } : { mode: 'rules' }, note: 'demo underwriter with synthetic DKIM fixtures' });
    }
    // A freshly signed demo email on every request. Each carries its own transaction ID, like real
    // provider emails, so it is never a duplicate of an earlier demo run (dedupe is on the body hash).
    const sample = req.method === 'GET' && req.url.match(/^\/samples\/(momo|deel|bank)\.eml$/);
    if (sample && sample[1] === 'momo') {
      // MTN MoMo Ghana sends a statement: a PDF on a signed email. A fresh phone number per request, because one
      // number may back only one wallet (a fixed demo number would lock out every wallet after the first).
      const eml = await fixtures.momoStatementEmail({ msisdn: fixtures.randomMsisdn() });
      res.writeHead(200, { 'content-type': 'message/rfc822', 'access-control-allow-origin': '*' });
      return res.end(eml);
    }
    if (sample) {
      const f = { deel: fixtures.deelPayout, bank: fixtures.bankStatement }[sample[1]];
      const eml = await fixtures.signedEmail({ body: `${f.body}\r\nTransaction ID: ${crypto.randomUUID()}`, domain: f.domain, from: f.from, subject: f.subject });
      res.writeHead(200, { 'content-type': 'message/rfc822', 'access-control-allow-origin': '*' });
      return res.end(eml);
    }
    if (req.method === 'POST' && req.url === '/underwrite') {
      const wallet = req.headers['x-wallet'];
      try { bs58.decode(String(wallet || '')); } catch { return send(400, { ok: false, reason: 'x-wallet header must be a base58 address' }); }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) return send(413, { ok: false, reason: 'email too large' }); chunks.push(c); }
      try { const r = await u.submit(Buffer.concat(chunks), String(wallet)); return send(r.ok ? 200 : 422, r); } catch (e) { return send(500, { ok: false, reason: e.message }); }
    }
    send(404, { ok: false, reason: 'not found' });
  });
}

/** Read enclave/.env (KEY=VALUE lines) into an object; never logged. */
export function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
