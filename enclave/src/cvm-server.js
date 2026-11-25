import http from 'node:http';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { Underwriter, DEFAULT_TRUSTED } from './underwriter.js';
import { llmConfigFromEnv } from './llm-extract.js';
import { getCreditHistory, getDeviceOwner, getIdentityOwner } from './chain-history.js';
import { handleDevice } from './device-http.js';
import { handleUnderwrite } from './underwrite-http.js';
import { makeRpc } from './chain-payout.js';
import { reportDataFor } from './attest.js';
import { Inbox, handleInbox } from './inbox.js';
import { createStoreFromEnv } from './store.js';
import { createAuthFromEnv } from './supabase-auth.js';
import { PepperError, cvmPepper } from './pepper.js';
import { createSampleLimiter, callerKey } from './sample-limit.js';

// The underwriter as it runs inside a Phala Cloud confidential VM (Intel TDX, dstack).
//
//  * The Ed25519 signing key is generated HERE, at boot, inside the TD. It is never written to disk, never
//    logged and never returned. The only thing that leaves is the public key, bound to the TDX quote:
//    report_data = sha256("notch-underwriter-v1" | pubkey [| nonce]).
//  * GET /attestation returns a real TDX quote from dstack plus the event log and the app-compose that the
//    compose-hash in RTMR3 commits to. enclave/scripts/verify-attestation.mjs checks all of it from outside.
//  * DEMO_FIXTURES=1 (set in the measured compose file, so it cannot be flipped quietly) trusts the synthetic
//    DKIM key from the test fixtures and serves signed sample emails. It is for the hackathon demo/e2e only.
//    Without it the server checks DKIM against real DNS like enclave/src/server.js.

const DEMO = process.env.DEMO_FIXTURES === '1';
const sampleLimiter = createSampleLimiter(); // demo only: GET /samples/*.eml is rate limited
const PORT = Number(process.env.PORT || 8787);

// ---- dstack: quote + info over /var/run/dstack.sock ----
const sdkMod = await import('@phala/dstack-sdk');
const sdk = sdkMod.default && !sdkMod.DstackClientV0 ? sdkMod.default : sdkMod;
// 0.6.x guest agents may answer the classic v0 routes (/GetQuote, /Info) or only v1; try v0 first, then v1.
// Built lazily so the server still boots (without attestation) outside a CVM, e.g. in local tests.
function makeClients() {
  return { v0: new sdk.DstackClientV0(), v1: new sdk.DstackClientV1() };
}
let dstackClients;
const dstack = {
  get v0() { return (dstackClients ??= makeClients()).v0; },
  get v1() { return (dstackClients ??= makeClients()).v1; },
};

async function teeEvidence(reportData) {
  let first;
  try {
    const q = await dstack.v0.getQuote(reportData);
    const info = await dstack.v0.info();
    return {
      api: 'v0',
      quote: q.quote,
      event_log: q.event_log,
      vm_config: q.vm_config || info.vm_config || null,
      app_compose: info.tcb_info?.app_compose ?? null,
      compose_hash: info.compose_hash ?? null,
      app_id: info.app_id ?? null,
      instance_id: info.instance_id ?? null,
      os_image_hash: info.tcb_info?.os_image_hash ?? null,
      mr_aggregated: info.tcb_info?.mr_aggregated ?? null,
    };
  } catch (e) {
    first = e;
  }
  try {
    const a = await dstack.v1.attest(reportData);
    const info = await dstack.v1.info();
    return {
      api: 'v1',
      attestation: Buffer.from(a.attestation).toString('hex'),
      vm_config: info.vm_config,
      app_compose: info.app_compose,
      compose_hash: Buffer.from(info.compose_hash).toString('hex'),
      app_id: Buffer.from(info.app_id).toString('hex'),
      instance_id: Buffer.from(info.instance_id).toString('hex'),
      os_image_hash: info.os_image_hash ? Buffer.from(info.os_image_hash).toString('hex') : null,
      mr_aggregated: info.mr_aggregated ? Buffer.from(info.mr_aggregated).toString('hex') : null,
    };
  } catch (e2) {
    throw new Error(`dstack unavailable (v0: ${first.message}; v1: ${e2.message})`);
  }
}

// ---- the underwriter, with a key born inside the TD ----
// The phone-number pepper is derived INSIDE the TD from the app's dstack key (stable across restarts and redeploys, never
// exported, never in an env var). Without it the server does not start; there is no insecure fallback in the CVM.
let idPepper;
try {
  idPepper = await cvmPepper(process.env, () => [dstack.v0, dstack.v1]);
} catch (e) {
  if (!(e instanceof PepperError)) throw e;
  console.error(`notch: ${e.message}`);
  process.exit(1);
}
const keys = nacl.sign.keyPair();
const fixtures = DEMO ? await import('../test/fixtures/emails.js') : null;
const llm = llmConfigFromEnv(process.env);
const u = new Underwriter({
  secretKey: keys.secretKey,
  idPepper,
  llm,
  historyProvider: getCreditHistory,
  identityProvider: getIdentityOwner,
  deviceProvider: getDeviceOwner,
  chainRpc: makeRpc(),
  usdcMint: process.env.NOTCH_USDC_MINT || undefined,
  ...(DEMO ? { resolver: fixtures.resolver, trusted: [...DEFAULT_TRUSTED, 'bank.test'] } : {}),
});
const inbox = new Inbox({ store: createStoreFromEnv(), auth: createAuthFromEnv() }); // memory + wallet-signature only unless NOTCH_STORE / SUPABASE_* are set
keys.secretKey.fill(0); // Underwriter copied what it needs; do not keep a second reference to the secret around.

let llmHost = null;
try { if (llm) llmHost = new URL(llm.url).host; } catch { /* leave null */ }
const modeInfo = () => ({
  demo_fixtures: DEMO,
  demo_note: DEMO
    ? 'DEMO_FIXTURES=1: trusts a synthetic DKIM key and serves fake sample emails. NOT production. Real provider mail cannot pass here.'
    : 'production mode: DKIM is checked against real DNS',
  extraction: llm ? { mode: 'llm', model: llm.model } : { mode: 'rules' },
  // The public identity hash (PDA ["identity", id_hash]) is peppered with a secret that exists only inside the TD.
  id_pepper: 'derived inside the TEE (dstack key derivation); never leaves it',
  // Honest disclosure: the AI reader is a normal hosted endpoint, outside this TEE, unless an operator points it at one.
  llm: {
    endpoint_host: llmHost,
    in_tee: process.env.NOTCH_LLM_IN_TEE === '1', // declared by the operator, NOT verified by this quote
    note: llm ? 'email text is sent to this endpoint for reading; it is outside the attested boundary unless in_tee is true and independently attested' : 'rules-only reader: no email text leaves the enclave',
  },
});

// One quote per second at most; a nonce'd request gets its own fresh quote.
let lastQuoteAt = 0;
async function attestation(nonceHex) {
  let nonce = null;
  if (nonceHex) {
    if (!/^[0-9a-f]{2,64}$/i.test(nonceHex) || nonceHex.length % 2) throw Object.assign(new Error('nonce must be 1..32 bytes of hex'), { status: 400 });
    nonce = Buffer.from(nonceHex, 'hex');
  }
  const wait = lastQuoteAt + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastQuoteAt = Date.now();
  const rd = reportDataFor(u.keys.publicKey, nonce);
  const ev = await teeEvidence(rd);
  return {
    underwriter: u.publicKey,
    tee: 'intel-tdx via dstack on Phala Cloud',
    binding: {
      scheme: 'report_data = sha256("notch-underwriter-v1" | ed25519 public key (32 bytes) [| nonce]), zero-padded to 64 bytes',
      nonce: nonceHex || null,
      report_data: rd.toString('hex'),
    },
    evidence: ev,
    mode: modeInfo(),
    generated_at: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj, extra = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extra });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-wallet, x-notch-token, x-notch-device, x-notch-ts, x-notch-sig, authorization' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
  try {
    if (await handleInbox(inbox, u, req, url, send)) return;
  } catch (e) {
    return send(500, { ok: false, reason: e.message });
  }
  if (await handleDevice(u, req, url, send)) return;
  if (req.method === 'GET' && url.pathname === '/attestation') {
    try {
      return send(200, await attestation(url.searchParams.get('nonce')));
    } catch (e) {
      return send(e.status || 500, { ok: false, reason: e.message });
    }
  }
  // Demo only: a freshly signed sample email per request (fresh MoMo number, fresh transaction id).
  const sample = DEMO && req.method === 'GET' && url.pathname.match(/^\/samples\/(momo|deel|bank)\.eml$/);
  if (sample) {
    // Demo only, and rate limited per caller and overall: a fresh signed income email is a fresh underwriter record (final gate #1).
    const taken = sampleLimiter.take(callerKey(req));
    if (!taken.ok) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(taken.retryAfterS), 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ ok: false, reason: `demo samples are rate limited (demo only): try again in ${taken.retryAfterS} s` }));
    }
    let eml;
    if (sample[1] === 'momo') {
      eml = await fixtures.momoStatementEmail({ msisdn: fixtures.randomMsisdn() });
    } else {
      const f = { deel: fixtures.deelPayout, bank: fixtures.bankStatement }[sample[1]];
      eml = await fixtures.signedEmail({ body: `${f.body}\r\nTransaction ID: ${crypto.randomUUID()}`, domain: f.domain, from: f.from, subject: f.subject });
    }
    res.writeHead(200, { 'content-type': 'message/rfc822', 'access-control-allow-origin': '*' });
    return res.end(eml);
  }
  if (await handleUnderwrite(u, req, url, send)) return;
  send(404, { ok: false, reason: 'not found' });
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`notch underwriter (TDX) ${u.publicKey} on :${PORT} demo_fixtures=${DEMO} extraction=${llm ? `llm ${llm.model}` : 'rules'}`));
