// Statement inbox: "MTN sends the statement straight to Notch".
//
// Each wallet gets its own mail address (the code is a short random id kept inside the enclave), in one of two styles:
//     <code>@<NOTCH_INBOX_DOMAIN>          our own mail domain (the default)
//     <local>+<code>@<domain>              one shared mailbox, NOTCH_INBOX_ADDRESS=<local>@<domain> (plus-addressing)
// The borrower asks MTN to mail the statement to that address. A Cloudflare Email Worker
// (deploy/cloudflare/email-worker.js) forwards the RAW message, unchanged, to POST /inbound; for a shared AgentMail
// mailbox, agentmail-bridge.js fetches it instead. The enclave then
//
//   1. checks the shared secret (the worker is the only caller),
//   2. maps the recipient address -> code -> wallet; unknown, expired, used and locked codes are refused,
//   3. runs the normal pipeline (DKIM from a trusted signer, PDF, income classes, limit) with the extra rule that the
//      mail must be tied to this very address (underwriter.js recipientRefusal),
//   4. signs the record and keeps it for that wallet to fetch: GET /record/<wallet> with the poll token.
//
// WHY AN ATTACKER CANNOT REDIRECT SOMEONE ELSE'S STATEMENT TO THEIR WALLET
//   * when the provider's DKIM signature covers To, mail addressed to Alice's code names Alice's address, so it is
//     refused at any other code;
//   * when it does not (MTN), To must equal the envelope address AND the SIGNED Date may not be older than the code, so an
//     existing statement cannot be sent to a newly asked address (a copy dated after the code was issued still can);
//   * the code is unguessable (50 bits), bound to ONE wallet at issue time, and the record can only be fetched with the
//     poll token that was returned with that code (so asking for a code "for" someone else's wallet reveals nothing);
//   * the wallet MUST prove it asked (since the Supabase layer, this is the default): either
//       - POST /inbox/new {wallet, ts, signature}: an Ed25519 signature over "notch-inbox-v1|<wallet>|<ts>", or
//       - POST /inbox/new {wallet} with `Authorization: Bearer <Supabase access token>` from "Sign in with Solana"
//         (supabase.auth.signInWithWeb3); the token's wallet, looked up at Supabase Auth, must be the requested wallet.
//     The only way to skip this is the constructor option `insecureAllowUnsignedForTests` (tests only, never set by a server);
//   * a code is single use: it is spent when a statement is ACCEPTED. Refusals do not spend it, but five of them lock it;
//   * one MoMo number still backs one wallet (identity link), whatever the route;
//   * Seeker binding is OPTIONAL, like on /underwrite: /inbox/new may carry the same Sign-in-with-Solana device proof
//     ({"device": {nonce, signature, signedMessage}} in the body, or the x-notch-device header). It is checked right
//     then (the nonce is single use and lives 5 minutes, the address lives 14 days) and the code remembers "this wallet
//     proved it holds its key for a device check". When the statement arrives the underwriter reads the wallet's
//     Seeker Genesis Token (mainnet, read only) and, if there is one, the record is a v3 record with the device hash
//     (and the Seeker limit uplift), exactly as on /underwrite. No proof, or a proof without a token: an ordinary
//     record, nothing lost. A Seeker who skips the proof simply gets no phone binding.
// The codes themselves stay in memory only: after a restart open codes are gone and the borrower asks for a new address.
// A PUBLIC status row per statement (received -> checking -> limit_posted | refused) goes to the `store` (memory by
// default, Supabase when configured) so a phone can watch it live. See supabase/README.md.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MemoryStore } from './store.js';
import { JobStatus } from './status.js';
import { verifyPostedTx } from './chain-posted.js';
import { makeRpc } from './chain-payout.js';
import { DeviceProofError } from './siws.js';
import { deviceProofFrom } from './device-http.js';

const DEFAULT_PROGRAM_ID = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz'; // same default as chain-history.js

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const CODE_LEN = 10;
const DEFAULT_DOMAIN = 'inbox.notch.invalid'; // .invalid never resolves: no domain is owned yet, set NOTCH_INBOX_DOMAIN
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024;

// "<local>@<domain>" of a shared mailbox -> its two halves, lower-cased. The local part has no "+": that is where the code goes.
export function parseMailbox(address) {
  const m = /^([a-z0-9._-]{1,53})@([a-z0-9.-]+\.[a-z]{2,})$/.exec(String(address || '').trim().toLowerCase());
  if (!m) throw new Error('NOTCH_INBOX_ADDRESS must be a plain <local>@<domain> address without "+"');
  return { local: m[1], domain: m[2] };
}

// The code a recipient address carries, or null. `mailbox` is parseMailbox()'s result for the plus style, null for
// <code>@<domain>. Not case sensitive.
export function recipientCode(rcpt, { domain, mailbox = null }) {
  const [local, host, extra] = String(rcpt || '').trim().toLowerCase().split('@');
  if (extra !== undefined || host !== domain) return null;
  let code = local;
  if (mailbox) {
    if (!local.startsWith(`${mailbox.local}+`)) return null;
    code = local.slice(mailbox.local.length + 1);
  }
  return new RegExp(`^[a-z2-7]{${CODE_LEN}}$`).test(code) ? code : null;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  return [...bytes].map((b) => B32[b & 31]).join('');
}

export class Inbox {
  constructor({
    domain,
    // The shared mailbox for plus-addressing. An explicit `domain` (and no `address`) keeps the <code>@<domain> style.
    address = domain === undefined ? process.env.NOTCH_INBOX_ADDRESS || '' : '',
    secret = process.env.NOTCH_INBOUND_SECRET || '',
    requireWalletSig = true, // a wallet proof is required by default; there is no env switch to turn it off
    insecureAllowUnsignedForTests = false, // TEST ONLY: lets /inbox/new skip the wallet proof. No server sets it.
    store = new MemoryStore(),
    auth = null, // SupabaseAuth (or anything with walletFor(jwt)): accepts a "Sign in with Solana" token as the proof
    ttlMs = 14 * 86400_000,
    maxPerWallet = 3,
    maxOpen = 20_000,
    maxFailures = 5,
    now = () => Date.now(),
  } = {}) {
    this.mailbox = address ? parseMailbox(address) : null;
    this.domain = this.mailbox ? this.mailbox.domain : String(domain ?? (process.env.NOTCH_INBOX_DOMAIN || DEFAULT_DOMAIN)).toLowerCase();
    this.secret = secret;
    this.requireWalletSig = requireWalletSig && !insecureAllowUnsignedForTests;
    this.store = store;
    this.status = new JobStatus(store);
    this.auth = auth;
    this.ttlMs = ttlMs;
    this.maxPerWallet = maxPerWallet;
    this.maxOpen = maxOpen;
    this.maxFailures = maxFailures;
    this.now = now;
    this.codes = new Map(); // code -> entry
  }

  get domainConfigured() {
    return this.mailbox !== null || this.domain !== DEFAULT_DOMAIN;
  }

  // The full address a code is reached at.
  addressFor(code) {
    return this.mailbox ? `${this.mailbox.local}+${code}@${this.domain}` : `${code}@${this.domain}`;
  }

  // The code in a recipient address of this inbox's style, or null.
  codeOf(rcpt) {
    return recipientCode(rcpt, this);
  }

  // Does this recipient name a code issued here (in any state)? The mail bridge asks before it downloads a message.
  knows(rcpt) {
    const code = this.codeOf(rcpt);
    return code !== null && this.codes.has(code);
  }

  // How logs describe where mail is expected.
  get describe() {
    return this.mailbox ? this.addressFor('<code>') : this.domain;
  }

  #purge() {
    const t = this.now();
    for (const [c, e] of this.codes) if (e.expires < t) this.codes.delete(c);
  }

  // -> { status, body }
  // `authedWallet`: the wallet a verified Supabase sign-in belongs to (handleInbox looks it up), or null.
  // `device` (optional): the SIWS device proof; `verifyDevice(wallet, proof)` checks it (Underwriter.verifyDevice) and throws
  // a DeviceProofError that is safe to show.
  async issue({ wallet, ts, signature, authedWallet = null, device, verifyDevice } = {}) {
    try {
      if (bs58.decode(String(wallet || '')).length !== 32) throw new Error('length');
    } catch {
      return { status: 400, body: { ok: false, reason: 'wallet must be a base58 Solana address' } };
    }
    if (authedWallet) {
      if (authedWallet !== wallet) return { status: 401, body: { ok: false, reason: 'the signed-in wallet is not the wallet you asked for' } };
    } else if (signature !== undefined || this.requireWalletSig) {
      const age = Math.abs(this.now() - Number(ts));
      let good = false;
      try {
        good = Number.isFinite(age) && age <= 10 * 60_000
          && nacl.sign.detached.verify(Buffer.from(`notch-inbox-v1|${wallet}|${ts}`), Buffer.from(String(signature), 'base64'), bs58.decode(wallet));
      } catch { /* bad signature encoding */ }
      if (!good) return { status: 401, body: { ok: false, reason: 'the wallet signature is missing, stale or wrong' } };
    }
    let deviceProven = false;
    if (device !== undefined && device !== null) {
      try {
        if (!verifyDevice) throw new DeviceProofError('device proof: this underwriter cannot check it');
        verifyDevice(wallet, device); // consumes the nonce; the signature must be THIS wallet's
        deviceProven = true;
      } catch (e) {
        if (e instanceof DeviceProofError) return { status: 401, body: { ok: false, reason: e.message } };
        throw e;
      }
    }
    this.#purge();
    if (this.codes.size >= this.maxOpen) return { status: 503, body: { ok: false, reason: 'too many open inbox addresses, try again later' } };
    const mine = [...this.codes].filter(([, e]) => e.wallet === wallet && e.state === 'open').sort((a, b) => a[1].created - b[1].created);
    while (mine.length >= this.maxPerWallet) { const [old] = mine.shift(); this.codes.delete(old); this.status.dropped(old); } // the oldest unused address makes room
    let code = newCode();
    while (this.codes.has(code)) code = newCode();
    const token = crypto.randomBytes(16).toString('hex');
    const created = this.now();
    this.codes.set(code, { wallet, tokenHash: sha(token).toString('hex'), created, expires: created + this.ttlMs, state: 'open', failures: 0, busy: false, result: null, deviceProven, deviceWallet: deviceProven ? wallet : null });
    // Public row: address -> wallet; no token, no secret. Awaited so the phone's live view knows the address before the
    // reply goes out. A store that is down does not block the inbox (the poll token still works): the reply says so.
    const liveStatus = await this.status.issued({ code, wallet, expiresAt: created + this.ttlMs });
    return {
      status: 200,
      body: {
        ok: true,
        address: this.addressFor(code),
        pollToken: token, // keep it: it is the only way to read the result
        expiresAt: new Date(created + this.ttlMs).toISOString(),
        domainConfigured: this.domainConfigured,
        ...(device !== undefined && device !== null ? { deviceProof: 'accepted' } : {}),
        liveStatus: liveStatus !== false,
        note: 'Ask MTN MoMo to email your statement to this address. It works once.',
      },
    };
  }

  // The raw message from the Cloudflare worker. `underwriter` is the Underwriter. -> { status, body }
  async receive(underwriter, { rcpt, eml, secret }) {
    if (!this.secret) return { status: 503, body: { ok: false, reason: 'the inbound endpoint is not configured (NOTCH_INBOUND_SECRET)' } };
    if (!secret || !safeEq(secret, this.secret)) return { status: 401, body: { ok: false, reason: 'bad inbound secret' } };
    const code = this.codeOf(rcpt);
    const entry = code && this.codes.get(code);
    if (!entry) return { status: 404, body: { ok: false, reason: 'unknown inbox address' } };
    if (entry.expires < this.now()) { this.codes.delete(code); this.status.dropped(code); return { status: 410, body: { ok: false, reason: 'this inbox address has expired' } }; }
    if (entry.state === 'used') return { status: 410, body: { ok: false, reason: 'this inbox address already received a statement; ask for a new one' } };
    if (entry.state === 'locked') return { status: 429, body: { ok: false, reason: 'this inbox address is locked after too many refused messages; ask for a new one' } };
    if (entry.busy) return { status: 409, body: { ok: false, reason: 'a message for this address is being processed' } };
    entry.busy = true;
    try {
      await this.status.received(code);
      await this.status.checking(code);
      let r;
      try {
        r = await underwriter.submit(eml, entry.wallet, { recipient: this.addressFor(code), issuedAt: entry.created, deviceProven: entry.deviceProven === true && entry.deviceWallet === entry.wallet });
      } catch (e) {
        await this.status.refused(code, 'internal error');
        throw e;
      }
      if (r.ok) {
        entry.state = 'used';
        entry.result = r;
        await this.status.limitPosted(code, r.message); // only the SHA-256 of the signed record goes out
        return { status: 200, body: { ok: true } }; // the limit is for the wallet, not for the mail path
      }
      if (r.retry) { // a Seeker-token lookup outage is nobody's fault: not a failure, the address stays usable
        entry.result = null;
        await this.status.refused(code, r.reason);
        return { status: 503, body: { ok: false, retry: true, reason: r.reason } };
      }
      entry.result = { ok: false, reason: r.reason };
      if (++entry.failures >= this.maxFailures) entry.state = 'locked';
      await this.status.refused(code, r.reason, { locked: entry.state === 'locked' }); // a coarse code, never the sentence
      return { status: 422, body: { ok: false, reason: r.reason } };
    } finally {
      entry.busy = false;
    }
  }

  // Someone reports the devnet transaction that posted a record. The chain decides, not the caller: the transaction
  // must be a successful Notch call carrying a record whose hash we issued. -> { status, body }
  async reportPosted({ signature, rpc, programId, localhostEndpoint }) {
    let v;
    try {
      v = await verifyPostedTx(rpc, { signature, programId, localhostEndpoint });
    } catch (e) {
      return { status: 422, body: { ok: false, reason: e.message } };
    }
    try {
      await this.store.attachTx({ recordSha256: v.recordSha256, txSignature: signature, cluster: v.cluster });
    } catch (e) {
      return { status: 404, body: { ok: false, reason: 'that transaction carries a record this underwriter did not issue (or it is already linked)' } };
    }
    return { status: 200, body: { ok: true, cluster: v.cluster } };
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
    const body = await readBody(req, 8192);
    let json;
    try { json = JSON.parse((body || Buffer.alloc(0)).toString('utf8')); } catch { json = null; }
    if (!json || typeof json !== 'object') { send(400, { ok: false, reason: 'send JSON {"wallet": "<address>"}' }); return true; }
    let device; // optional Seeker proof: in the body, or in the same x-notch-device header /underwrite takes
    try { device = json.device ?? deviceProofFrom(req); } catch (e) { send(400, { ok: false, reason: e.message }); return true; }
    if (device !== undefined && (typeof device !== 'object' || device === null || Array.isArray(device))) { send(400, { ok: false, reason: 'device proof: send {"nonce","signature","signedMessage"}' }); return true; }
    let authedWallet = null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
    if (bearer) {
      if (!inbox.auth) { send(401, { ok: false, reason: 'Sign in with Solana is not configured on this underwriter; sign the request with the wallet instead' }); return true; }
      authedWallet = await inbox.auth.walletFor(bearer);
      if (!authedWallet) { send(401, { ok: false, reason: 'the Supabase sign-in is invalid, expired, or not a Solana wallet' }); return true; }
    }
    const r = await inbox.issue({ wallet: json.wallet, ts: json.ts, signature: json.signature, authedWallet, device, verifyDevice: (w, p) => underwriter.verifyDevice(w, p) });
    send(r.status, r.body);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/posted') {
    const body = await readBody(req, 2048);
    let json;
    try { json = JSON.parse((body || Buffer.alloc(0)).toString('utf8')); } catch { json = null; }
    if (!json || typeof json.signature !== 'string') { send(400, { ok: false, reason: 'send JSON {"signature": "<devnet transaction signature>"}' }); return true; }
    const endpoint = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const r = await inbox.reportPosted({
      signature: json.signature,
      rpc: inbox.chainRpc || (inbox.chainRpc = makeRpc({ endpoint })),
      programId: process.env.NOTCH_PROGRAM_ID || DEFAULT_PROGRAM_ID,
      localhostEndpoint: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(endpoint),
    });
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
