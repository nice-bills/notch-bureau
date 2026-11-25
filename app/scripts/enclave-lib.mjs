// Shared demo-underwriter pieces: the Underwriter (same class as the real enclave) wired to the
// synthetic DKIM fixtures, plus the tiny HTTP server in front of it. Used by demo-enclave.mjs
// (the long-running demo server) and e2e-devnet.mjs (which runs its own copy on a random port so it
// can sign fresh emails: the fixtures' DKIM key lives in the process that imports them).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Underwriter, DEFAULT_TRUSTED } from '../../enclave/src/underwriter.js';
import { handleDevice } from '../../enclave/src/device-http.js';
import { handleUnderwrite } from '../../enclave/src/underwrite-http.js';
import * as fixtures from '../../enclave/test/fixtures/emails.js';
import { createSampleLimiter, callerKey } from '../../enclave/src/sample-limit.js';

export { fixtures };

/** Underwriter keyed from `keyFile` (created if missing; omit for a throwaway in-memory key). */
export function makeUnderwriter(keyFile, { llm = null, cls = Underwriter, ...extra } = {}) {
  let secretKey;
  if (keyFile && fs.existsSync(keyFile)) secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, 'utf8')));
  const u = new cls({ secretKey, resolver: fixtures.resolver, trusted: [...DEFAULT_TRUSTED, 'bank.test'], llm, ...extra });
  if (keyFile && !secretKey) fs.writeFileSync(keyFile, JSON.stringify(Array.from(u.keys.secretKey)), { mode: 0o600 });
  return u;
}

/** The HTTP surface of the underwriter. Reply shapes come straight from Underwriter.submit(). */
export function makeServer(u, opts = {}) {
  // Demo only: samples are rate-limited per caller and overall (enclave/src/sample-limit.js). A direct loopback caller (the local
  // e2e runs, the dev's own browser) is exempt unless `opts.samples.exemptLoopback` is false.
  const samples = opts.samples?.limiter ?? createSampleLimiter(opts.samples);
  const exemptLoopback = opts.samples?.exemptLoopback ?? true;
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-wallet, x-notch-device, x-notch-ts, x-notch-sig' }); return res.end(); }
    if (await handleDevice(u, req, new URL(req.url, 'http://x'), send)) return;
    if (req.method === 'GET' && req.url === '/attestation') {
      return send(200, { underwriter: u.publicKey, mode: 'local-dev', extraction: u.llm ? { mode: 'llm', model: u.llm.model } : { mode: 'rules' }, note: 'demo underwriter with synthetic DKIM fixtures' });
    }
    // A freshly signed demo email on every request. Each carries its own transaction ID, like real
    // provider emails, so it is never a duplicate of an earlier demo run (dedupe is on the body hash).
    const sample = req.method === 'GET' && req.url.match(/^\/samples\/(momo|deel|bank)\.eml$/);
    if (sample) {
      const key = (opts.samples?.keyOf ?? callerKey)(req);
      const loopback = !req.headers['x-forwarded-for'] && /^(::1|127\.|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ''));
      const taken = exemptLoopback && loopback ? { ok: true } : samples.take(key);
      if (!taken.ok) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(taken.retryAfterS), 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: false, reason: `demo samples are rate limited (demo only): try again in ${taken.retryAfterS} s` }));
      }
    }
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
    if (await handleUnderwrite(u, req, new URL(req.url, 'http://x'), send, opts)) return;
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
