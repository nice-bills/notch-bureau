// Statement inbox: "MTN sends the statement straight to Notch".
//
// Each wallet gets its own mail address  <code>@<NOTCH_INBOX_DOMAIN>  (the code is a short random id kept inside the
// enclave). The borrower asks MTN to mail the statement to that address. A Cloudflare Email Worker
// (deploy/cloudflare/email-worker.js) forwards the RAW message, unchanged, to POST /inbound. The enclave then
//
//   1. checks the shared secret (the worker is the only caller),
//   2. maps the recipient address -> code -> wallet; unknown, expired, used and locked codes are refused,
//   3. runs the normal pipeline (DKIM from a trusted signer, PDF, income classes, limit) with the extra rule that the
//      DKIM-SIGNED To header must name this very address,
//   4. signs the record and keeps it for that wallet to fetch: GET /record/<wallet> with the poll token.
//
// WHY AN ATTACKER CANNOT REDIRECT SOMEONE ELSE'S STATEMENT TO THEIR WALLET
//   * a statement is DKIM-signed with its To header covered; mail addressed to Alice's code names Alice's address, so
//     it is refused at any other code (the To check), and the enclave never trusts the envelope alone;
//   * the code is unguessable (50 bits), bound to ONE wallet at issue time, and the record can only be fetched with the
//     poll token that was returned with that code (so asking for a code "for" someone else's wallet reveals nothing);
//   * optionally the wallet proves it asked: POST /inbox/new {wallet, ts, signature} with an Ed25519 signature over
//     "notch-inbox-v1|<wallet>|<ts>" (NOTCH_INBOX_REQUIRE_WALLET_SIG=1 makes it mandatory);
//   * a code is single use: it is spent when a statement is ACCEPTED. Refusals do not spend it, but five of them lock it;
//   * one phone number still backs one wallet (identity link), whatever the route.
// State is in memory only: after a restart open codes are gone and the borrower asks for a new address.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const CODE_LEN = 10;
const DEFAULT_DOMAIN = 'inbox.notch.invalid'; // .invalid never resolves: no domain is owned yet, set NOTCH_INBOX_DOMAIN
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  return [...bytes].map((b) => B32[b & 31]).join('');
}

export class Inbox {
  constructor({
    domain = process.env.NOTCH_INBOX_DOMAIN || DEFAULT_DOMAIN,
    secret = process.env.NOTCH_INBOUND_SECRET || '',
    requireWalletSig = process.env.NOTCH_INBOX_REQUIRE_WALLET_SIG === '1',
    ttlMs = 14 * 86400_000,
    maxPerWallet = 3,
    maxOpen = 20_000,
    maxFailures = 5,
    now = () => Date.now(),
  } = {}) {
    this.domain = String(domain).toLowerCase();
    this.secret = secret;
    this.requireWalletSig = requireWalletSig;
    this.ttlMs = ttlMs;
    this.maxPerWallet = maxPerWallet;
    this.maxOpen = maxOpen;
    this.maxFailures = maxFailures;
    this.now = now;
    this.codes = new Map(); // code -> entry
  }

  get domainConfigured() {
    return this.domain !== DEFAULT_DOMAIN;
  }

  #purge() {
    const t = this.now();
    for (const [c, e] of this.codes) if (e.expires < t) this.codes.delete(c);
  }

  // -> { status, body }
  issue({ wallet, ts, signature } = {}) {
    try {
      if (bs58.decode(String(wallet || '')).length !== 32) throw new Error('length');
    } catch {
      return { status: 400, body: { ok: false, reason: 'wallet must be a base58 Solana address' } };
    }
    if (signature !== undefined || this.requireWalletSig) {
      const age = Math.abs(this.now() - Number(ts));
      let good = false;
      try {
        good = Number.isFinite(age) && age <= 10 * 60_000
          && nacl.sign.detached.verify(Buffer.from(`notch-inbox-v1|${wallet}|${ts}`), Buffer.from(String(signature), 'base64'), bs58.decode(wallet));
      } catch { /* bad signature encoding */ }
      if (!good) return { status: 401, body: { ok: false, reason: 'the wallet signature is missing, stale or wrong' } };
    }
    this.#purge();
    if (this.codes.size >= this.maxOpen) return { status: 503, body: { ok: false, reason: 'too many open inbox addresses, try again later' } };
    const mine = [...this.codes].filter(([, e]) => e.wallet === wallet && e.state === 'open').sort((a, b) => a[1].created - b[1].created);
    while (mine.length >= this.maxPerWallet) this.codes.delete(mine.shift()[0]); // the oldest unused address makes room
    let code = newCode();
    while (this.codes.has(code)) code = newCode();
    const token = crypto.randomBytes(16).toString('hex');
    const created = this.now();
    this.codes.set(code, { wallet, tokenHash: sha(token).toString('hex'), created, expires: created + this.ttlMs, state: 'open', failures: 0, busy: false, result: null });
    return {
      status: 200,
      body: {
        ok: true,
        address: `${code}@${this.domain}`,
        pollToken: token, // keep it: it is the only way to read the result
        expiresAt: new Date(created + this.ttlMs).toISOString(),
        domainConfigured: this.domainConfigured,
        note: 'Ask MTN MoMo to email your statement to this address. It works once.',
      },
    };
  }

  // The raw message from the Cloudflare worker. `underwriter` is the Underwriter. -> { status, body }
  async receive(underwriter, { rcpt, eml, secret }) {
    if (!this.secret) return { status: 503, body: { ok: false, reason: 'the inbound endpoint is not configured (NOTCH_INBOUND_SECRET)' } };
    if (!secret || !safeEq(secret, this.secret)) return { status: 401, body: { ok: false, reason: 'bad inbound secret' } };
    const m = new RegExp(`^([a-z2-7]{${CODE_LEN}})@${this.domain.replace(/[.]/g, '\\.')}$`).exec(String(rcpt || '').trim().toLowerCase());
    const entry = m && this.codes.get(m[1]);
    if (!entry) return { status: 404, body: { ok: false, reason: 'unknown inbox address' } };
    if (entry.expires < this.now()) { this.codes.delete(m[1]); return { status: 410, body: { ok: false, reason: 'this inbox address has expired' } }; }
    if (entry.state === 'used') return { status: 410, body: { ok: false, reason: 'this inbox address already received a statement; ask for a new one' } };
    if (entry.state === 'locked') return { status: 429, body: { ok: false, reason: 'this inbox address is locked after too many refused messages; ask for a new one' } };
    if (entry.busy) return { status: 409, body: { ok: false, reason: 'a message for this address is being processed' } };
    entry.busy = true;
    try {
      const r = await underwriter.submit(eml, entry.wallet, { recipient: `${m[1]}@${this.domain}` });
      if (r.ok) {
        entry.state = 'used';
        entry.result = r;
        return { status: 200, body: { ok: true } }; // the limit is for the wallet, not for the mail path
      }
      entry.result = { ok: false, reason: r.reason };
      if (++entry.failures >= this.maxFailures) entry.state = 'locked';
      return { status: 422, body: { ok: false, reason: r.reason } };
    } finally {
      entry.busy = false;
    }
  }

  // The borrower's poll. -> { status, body }
  poll(wallet, token) {
    this.#purge();
    const h = token ? sha(token).toString('hex') : null;
    const entries = [...this.codes.values()].filter((e) => e.wallet === wallet && h && e.tokenHash === h);
    if (!entries.length) return { status: 404, body: { ok: false, reason: 'no such inbox for this wallet and token' } };
    const e = entries[0];
    if (e.state === 'used') return { status: 200, body: { status: 'ready', ...e.result } };
    if (e.state === 'locked') return { status: 200, body: { status: 'locked', ok: false, reason: e.result?.reason } };
    if (e.result && !e.result.ok) return { status: 200, body: { status: 'refused', ok: false, reason: e.result.reason } };
    return { status: 200, body: { status: 'waiting', ok: false } };
  }
}

// ---- HTTP glue shared by server.js and cvm-server.js ----------------------------------------------------------------

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Returns true when the request was an inbox route (and has been answered).
export async function handleInbox(inbox, underwriter, req, url, send) {
  if (req.method === 'POST' && url.pathname === '/inbox/new') {
    const body = await readBody(req, 4096);
    let json;
    try { json = JSON.parse((body || Buffer.alloc(0)).toString('utf8')); } catch { json = null; }
    if (!json || typeof json !== 'object') { send(400, { ok: false, reason: 'send JSON {"wallet": "<address>"}' }); return true; }
    const r = inbox.issue({ wallet: json.wallet, ts: json.ts, signature: json.signature });
    send(r.status, r.body);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/inbound') {
    const eml = await readBody(req, MAX_INBOUND_BYTES);
    if (!eml) { send(413, { ok: false, reason: 'message too large' }); return true; }
    try {
      const r = await inbox.receive(underwriter, { rcpt: req.headers['x-notch-rcpt'], eml, secret: req.headers['x-notch-inbound-secret'] });
      send(r.status, r.body);
    } catch (e) {
      console.error('inbound error:', e.message);
      send(500, { ok: false, reason: 'could not process the message' });
    }
    return true;
  }
  const m = req.method === 'GET' && url.pathname.match(/^\/record\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) {
    const r = inbox.poll(m[1], req.headers['x-notch-token'] || url.searchParams.get('token'));
    send(r.status, r.body);
    return true;
  }
  return false;
}
