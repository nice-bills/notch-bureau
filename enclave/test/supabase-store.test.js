// The store adapter: memory (default, what every test uses), a real Postgres (PGlite, running the real migrations)
// and the Supabase REST client (against a stub fetch). All three must follow the same status rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MemoryStore, PgStore, SupabaseStore, createStoreFromEnv, recordSha256, REASON_CODES } from '../src/store.js';
import { JobStatus, reasonCode } from '../src/status.js';
import { newDb } from '../../supabase/tests/harness.js';

const W = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const SHA = 'ab'.repeat(32);
const SIG = '4'.repeat(88);

async function pgStore() {
  const db = await newDb(PGlite);
  return { store: new PgStore({ query: (sql, params) => db.query(sql, params) }), db };
}

// What each adapter holds after the steps below, in one comparable shape.
async function view(kind, store, db) {
  if (kind === 'memory') {
    return {
      codes: [...store.codes].map(([code, c]) => ({ code, wallet: c.wallet, state: c.state })),
      jobs: [...store.jobs].map(([code, j]) => ({ code, status: j.status, reason: j.reasonCode, attempts: j.attempts })),
      records: [...store.records].map(([sha, r]) => ({ sha, tx: r.txSignature, cluster: r.cluster })),
    };
  }
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    codes: await q('select code, wallet, state from public.inbox_codes order by code'),
    jobs: (await q('select code, status, reason_code as reason, attempts from public.inbox_jobs order by code')),
    records: await q('select record_sha256 as sha, tx_signature as tx, cluster from public.posted_records'),
  };
}

for (const kind of ['memory', 'postgres']) {
  test(`${kind} store: the same steps give the same rows and the same refusals`, async () => {
    let store; let db;
    if (kind === 'memory') store = new MemoryStore(); else ({ store, db } = await pgStore());
    const exp = new Date(Date.now() + 86400_000);
    await store.inboxIssued({ code: 'aaaaaaaaaa', wallet: W, expiresAt: exp });
    await store.inboxIssued({ code: 'bbbbbbbbbb', wallet: W, expiresAt: exp });
    await assert.rejects(store.jobUpdate({ code: 'aaaaaaaaaa', status: 'checking' }), /must start as received/);
    await assert.rejects(store.jobUpdate({ code: 'nnnnnnnnnn', status: 'received' }), /unknown inbox code/);
    await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'received' });
    await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'checking' });
    await assert.rejects(store.jobUpdate({ code: 'aaaaaaaaaa', status: 'refused', reasonCode: 'a long sentence with 5000 GHS' }));
    await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'refused', reasonCode: 'no_income' });
    await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'received' }); // retry
    await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'checking' });
    await store.limitPosted({ code: 'aaaaaaaaaa', recordSha256: SHA });
    await assert.rejects(store.jobUpdate({ code: 'aaaaaaaaaa', status: 'refused', reasonCode: 'other' }), /cannot go from limit_posted/);
    await store.inboxState({ code: 'bbbbbbbbbb', state: 'locked' });
    await store.inboxState({ code: 'aaaaaaaaaa', state: 'locked' }); // a used address stays used
    await assert.rejects(store.attachTx({ recordSha256: 'cd'.repeat(32), txSignature: SIG, cluster: 'devnet' }), /no such record/);
    await store.attachTx({ recordSha256: SHA, txSignature: SIG, cluster: 'devnet' });
    await assert.rejects(store.attachTx({ recordSha256: SHA, txSignature: '5'.repeat(88), cluster: 'devnet' }), /different transaction/);
    assert.deepEqual(await view(kind, store, db), {
      codes: [{ code: 'aaaaaaaaaa', wallet: W, state: 'used' }, { code: 'bbbbbbbbbb', wallet: W, state: 'locked' }],
      jobs: [{ code: 'aaaaaaaaaa', status: 'limit_posted', reason: null, attempts: 2 }],
      records: [{ sha: SHA, tx: SIG, cluster: 'devnet' }],
    });
    await store.keeperRun({ cluster: 'devnet', lines: 2, overdue: 1, marked: 1, failed: 0, signatures: [SIG], dry: false });
  });
}

test('supabase store: calls the notch_* functions over PostgREST with the service-role key, and surfaces errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return url.endsWith('notch_attach_tx')
      ? new Response(JSON.stringify({ message: 'no such record' }), { status: 400 })
      : new Response(null, { status: 204 });
  };
  const store = new SupabaseStore({ url: 'https://abc.supabase.co/', serviceKey: 'service-key', fetchImpl });
  await store.inboxIssued({ code: 'aaaaaaaaaa', wallet: W, expiresAt: 0 });
  await store.jobUpdate({ code: 'aaaaaaaaaa', status: 'refused', reasonCode: 'dkim_failed' });
  await store.limitPosted({ code: 'aaaaaaaaaa', recordSha256: SHA });
  await assert.rejects(store.attachTx({ recordSha256: SHA, txSignature: SIG, cluster: 'devnet' }), /notch_attach_tx: 400 no such record/);
  assert.deepEqual(calls.map((c) => c.url), [
    'https://abc.supabase.co/rest/v1/rpc/notch_inbox_issued',
    'https://abc.supabase.co/rest/v1/rpc/notch_job_update',
    'https://abc.supabase.co/rest/v1/rpc/notch_limit_posted',
    'https://abc.supabase.co/rest/v1/rpc/notch_attach_tx',
  ]);
  assert.equal(calls[0].init.headers.apikey, 'service-key');
  assert.equal(calls[0].init.headers.authorization, 'Bearer service-key');
  assert.deepEqual(calls[1].body, { p_code: 'aaaaaaaaaa', p_status: 'refused', p_reason: 'dkim_failed' });
  assert.deepEqual(calls[2].body, { p_code: 'aaaaaaaaaa', p_record_sha256: SHA });
  assert.throws(() => new SupabaseStore({ url: 'https://x.supabase.co' }), /SUPABASE_SERVICE_ROLE_KEY/);
});

test('createStoreFromEnv: memory by default, and without credentials supabase falls back to memory loudly', () => {
  assert.equal(createStoreFromEnv({}).kind, 'memory');
  assert.equal(createStoreFromEnv({ NOTCH_STORE: 'memory', SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }).kind, 'memory');
  const warned = [];
  assert.equal(createStoreFromEnv({ NOTCH_STORE: 'supabase' }, { log: (m) => warned.push(m) }).kind, 'memory');
  assert.match(warned[0], /missing/);
  assert.equal(createStoreFromEnv({ NOTCH_STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }).kind, 'supabase');
  assert.throws(() => createStoreFromEnv({ NOTCH_STORE: 'mongo' }), /unknown NOTCH_STORE/);
});

test('reason codes: every real refusal sentence maps to a fixed code, and the sentence is not kept', () => {
  const cases = {
    'untrusted signer (evil.example)': 'dkim_failed',
    'no passing DKIM signature (none)': 'dkim_failed',
    'DKIM signature does not cover the To header, so the recipient cannot be trusted': 'wrong_inbox',
    'the statement was not addressed to this inbox': 'wrong_inbox',
    'email already used': 'already_counted',
    'no new income in this statement: every credit in it was already counted': 'already_counted',
    'this mobile-money account is already linked to a different wallet': 'identity_conflict',
    'the email has no PDF statement attached': 'no_statement',
    'no earned income found: money from yourself, loans, betting': 'no_income',
    'could not find the account phone number in the statement': 'unreadable',
    'the statement table does not add up (3 of 40 rows break the running balance), so it cannot be read reliably': 'unreadable',
    'something nobody planned for': 'other',
  };
  for (const [text, code] of Object.entries(cases)) {
    assert.equal(reasonCode(text), code, text);
    assert.ok(REASON_CODES.includes(reasonCode(text)));
  }
});

test('a failing store never throws into the underwriter, and steps for one address run in order', async () => {
  const logs = [];
  const broken = { inboxIssued: async () => { throw new Error('supabase down'); }, jobUpdate: async () => { throw new Error('supabase down'); } };
  const s = new JobStatus(broken, { log: (m) => logs.push(m) });
  s.issued({ code: 'aaaaaaaaaa', wallet: W, expiresAt: 1 });
  await s.received('aaaaaaaaaa');
  assert.equal(logs.length, 2);
  const order = [];
  const slow = {
    inboxIssued: async () => { await new Promise((r) => setTimeout(r, 30)); order.push('issued'); },
    jobUpdate: async ({ status }) => { order.push(status); },
  };
  const s2 = new JobStatus(slow);
  s2.issued({ code: 'aaaaaaaaaa', wallet: W, expiresAt: 1 }); // not awaited, like Inbox.issue
  await s2.received('aaaaaaaaaa');
  assert.deepEqual(order, ['issued', 'received']);
});

test('record hash is the SHA-256 of the 128 signed bytes', () => {
  const bytes = Buffer.alloc(128, 7);
  assert.equal(recordSha256(bytes.toString('base64')).length, 64);
  assert.notEqual(recordSha256(bytes.toString('base64')), recordSha256(Buffer.alloc(128, 8).toString('base64')));
});
