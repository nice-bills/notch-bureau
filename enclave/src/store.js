// Where the underwriter writes its PUBLIC status: which statement address belongs to which wallet, the live status of
// each statement (received -> checking -> limit_posted | refused), the SHA-256 of each signed record and the devnet
// transaction that posted it. It never receives a statement, a phone number, a name or an amount.
//
// One interface, three adapters:
//   MemoryStore    the default. Everything in this process; what every test uses. Nothing needs credentials.
//   SupabaseStore  the live project, over PostgREST with the service-role key (NOTCH_STORE=supabase).
//   PgStore        any Postgres reachable through `query(sql, params)`; the tests drive a real embedded Postgres
//                  (PGlite) with it, so the SQL in supabase/migrations is exercised for real.
// MemoryStore mirrors the SQL status rules in supabase/migrations/..._notch_core.sql (same order, same errors).
import crypto from 'node:crypto';

export const STATUSES = ['received', 'checking', 'limit_posted', 'refused'];
export const REASON_CODES = ['dkim_failed', 'wrong_inbox', 'no_statement', 'unreadable', 'no_income', 'already_counted', 'identity_conflict', 'locked', 'expired', 'other'];
const NEXT = new Set(['received>checking', 'received>refused', 'checking>limit_posted', 'checking>refused', 'refused>received']);

// Interface (all async). Implementations throw on a refused write; callers that must not break (status reporting) catch.
//   inboxIssued({ code, wallet, expiresAt })           a new statement address
//   inboxState({ code, state })                        'open' | 'used' | 'locked' | 'expired'
//   jobUpdate({ code, status, reasonCode? })           one status step
//   limitPosted({ code, recordSha256 })                limit_posted + the record's hash, together
//   attachTx({ recordSha256, txSignature, cluster })   the devnet transaction that posted that record
//   keeperRun({ cluster, lines, overdue, marked, failed, signatures, dry })
export class MemoryStore {
  constructor({ max = 20_000 } = {}) {
    this.kind = 'memory';
    this.max = max;
    this.codes = new Map(); // code -> { wallet, state, expiresAt }
    this.jobs = new Map(); // code -> { wallet, status, reasonCode, attempts }
    this.records = new Map(); // sha -> { code, wallet, txSignature, cluster }
    this.runs = [];
    this.log = []; // every status step in order: [{ code, status, reasonCode }], for tests and local demos
  }

  async inboxIssued({ code, wallet, expiresAt }) {
    if (this.codes.size >= this.max) { const first = this.codes.keys().next().value; this.codes.delete(first); this.jobs.delete(first); }
    if (!this.codes.has(code)) this.codes.set(code, { wallet, state: 'open', expiresAt: new Date(expiresAt).toISOString() });
  }

  async inboxState({ code, state }) {
    const c = this.codes.get(code);
    if (c && c.state !== 'used') c.state = state;
  }

  async jobUpdate({ code, status, reasonCode = null }) {
    const c = this.codes.get(code);
    if (!c) throw new Error('unknown inbox code');
    if (status === 'refused' && !REASON_CODES.includes(reasonCode)) throw new Error('refused needs a coarse reason code');
    const cur = this.jobs.get(code);
    if (!cur) {
      if (status !== 'received') throw new Error('a job must start as received');
      this.jobs.set(code, { wallet: c.wallet, status, reasonCode: null, attempts: 1 });
    } else if (NEXT.has(`${cur.status}>${status}`)) {
      if (cur.status === 'refused') cur.attempts += 1;
      cur.reasonCode = status === 'refused' ? reasonCode : null;
      cur.status = status;
    } else throw new Error(`job cannot go from ${cur.status} to ${status}`);
    if (status === 'limit_posted') c.state = 'used';
    this.log.push({ code, status, reasonCode: status === 'refused' ? reasonCode : null });
  }

  async limitPosted({ code, recordSha256 }) {
    await this.jobUpdate({ code, status: 'limit_posted' });
    this.records.set(recordSha256, { code, wallet: this.codes.get(code).wallet, txSignature: null, cluster: null });
  }

  async attachTx({ recordSha256, txSignature, cluster }) {
    const r = this.records.get(recordSha256);
    if (!r || (r.txSignature && r.txSignature !== txSignature)) throw new Error('no such record, or it already has a different transaction');
    r.txSignature = txSignature;
    r.cluster = cluster;
  }

  async keeperRun(run) { this.runs.push(run); }
}

// The server side of the same calls is the notch_* SQL functions; both remote adapters just call them.
const RPC = {
  inboxIssued: ['notch_inbox_issued', (a) => ({ p_code: a.code, p_wallet: a.wallet, p_expires: new Date(a.expiresAt).toISOString() })],
  inboxState: ['notch_inbox_state', (a) => ({ p_code: a.code, p_state: a.state })],
  jobUpdate: ['notch_job_update', (a) => ({ p_code: a.code, p_status: a.status, p_reason: a.reasonCode ?? null })],
  limitPosted: ['notch_limit_posted', (a) => ({ p_code: a.code, p_record_sha256: a.recordSha256 })],
  attachTx: ['notch_attach_tx', (a) => ({ p_record_sha256: a.recordSha256, p_tx_signature: a.txSignature, p_cluster: a.cluster })],
  keeperRun: ['notch_keeper_run', (a) => ({ p_cluster: a.cluster, p_lines: a.lines, p_overdue: a.overdue, p_marked: a.marked, p_failed: a.failed ?? 0, p_sigs: a.signatures ?? [], p_dry: !!a.dry })],
};

class RpcStore {
  constructor() {
    for (const [method, [fn, args]] of Object.entries(RPC)) this[method] = (a) => this.call(fn, args(a));
  }
}

// Live Supabase project. `serviceKey` is the service-role key (a secret: env only, never committed).
export class SupabaseStore extends RpcStore {
  constructor({ url, serviceKey, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    super();
    if (!url || !serviceKey) throw new Error('SupabaseStore needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    this.kind = 'supabase';
    this.base = String(url).replace(/\/+$/, '');
    this.serviceKey = serviceKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(fn, args) {
    const r = await this.fetch(`${this.base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch { /* no body */ }
      throw new Error(`supabase ${fn}: ${r.status} ${msg}`.trim());
    }
  }
}

// Any Postgres with the migrations applied. `query(sql, params)` -> a promise (PGlite's db.query fits).
export class PgStore extends RpcStore {
  constructor({ query }) {
    super();
    this.kind = 'postgres';
    this.query = query;
  }

  async call(fn, args) {
    const keys = Object.keys(args);
    const cast = { p_expires: '::timestamptz', p_sigs: '::text[]' };
    await this.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${cast[k] || ''}`).join(', ')})`, keys.map((k) => args[k]));
  }
}

// NOTCH_STORE=memory (default) | supabase. Without credentials it falls back to memory and says so.
export function createStoreFromEnv(env = process.env, { log = console.warn, fetchImpl } = {}) {
  const kind = (env.NOTCH_STORE || 'memory').toLowerCase();
  if (kind === 'memory') return new MemoryStore();
  if (kind === 'supabase') {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      log('NOTCH_STORE=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing: using the in-memory store');
      return new MemoryStore();
    }
    return new SupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl });
  }
  throw new Error(`unknown NOTCH_STORE "${kind}" (memory | supabase)`);
}

export const recordSha256 = (messageB64) => crypto.createHash('sha256').update(Buffer.from(messageB64, 'base64')).digest('hex');
