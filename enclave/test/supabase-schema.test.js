// The Supabase schema and its row-level security, against a REAL Postgres (PGlite) with the real migration files.
// "Wallet A cannot read wallet B's rows" and "anon cannot write" are checked by actually trying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { newDb, asRole, createWeb3User } from '../../supabase/tests/harness.js';

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const sha = (c) => c.repeat(64);
const SIG = '5'.repeat(88);
const denied = /permission denied|row-level security/;

async function world() {
  const db = await newDb(PGlite);
  const A = wallet();
  const B = wallet();
  const userA = await createWeb3User(db, A);
  const userB = await createWeb3User(db, B);
  const svc = (fn) => asRole(db, 'service_role', fn);
  await svc(async () => {
    await db.query("select public.notch_inbox_issued('aaaaaaaaaa', $1, now() + interval '1 day')", [A]);
    await db.query("select public.notch_inbox_issued('bbbbbbbbbb', $1, now() + interval '1 day')", [B]);
    for (const c of ['aaaaaaaaaa', 'bbbbbbbbbb']) {
      await db.query('select public.notch_job_update($1, $2)', [c, 'received']);
      await db.query('select public.notch_job_update($1, $2)', [c, 'checking']);
    }
    await db.query("select public.notch_limit_posted('aaaaaaaaaa', $1)", [sha('a')]);
    await db.query("select public.notch_limit_posted('bbbbbbbbbb', $1)", [sha('b')]);
  });
  return { db, A, B, userA, userB, svc };
}

test('privacy claim: the tables have no column that could hold a statement, number, name or amount', async () => {
  const { db } = await world();
  const { rows } = await db.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position");
  const shape = Object.fromEntries(Object.entries(Object.groupBy(rows, (r) => r.table_name)).map(([t, cols]) => [t, cols.map((c) => c.column_name)]));
  assert.deepEqual(shape, {
    inbox_codes: ['code', 'wallet', 'state', 'created_at', 'expires_at'],
    inbox_jobs: ['code', 'wallet', 'status', 'reason_code', 'attempts', 'created_at', 'updated_at'],
    posted_records: ['record_sha256', 'code', 'wallet', 'tx_signature', 'cluster', 'created_at', 'posted_at'],
    keeper_runs: ['id', 'ran_at', 'cluster', 'lines_seen', 'overdue', 'marked', 'failed', 'tx_signatures', 'dry_run'],
  });
  // free text columns are all pinned by a pattern or a fixed list, so none can carry a sentence from an email
  const { rows: checks } = await db.query("select conrelid::regclass::text as t, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace");
  const defs = checks.map((c) => c.def).join('\n');
  for (const col of ['code', 'wallet', 'state', 'status', 'reason_code', 'record_sha256', 'tx_signature', 'cluster']) assert.match(defs, new RegExp(`\\b${col}\\b`), `${col} is constrained`);
});

test('a signed-in wallet reads its own rows and only its own', async () => {
  const { db, A, B, userA, userB } = await world();
  const seen = (user) => asRole(db, 'authenticated', async () => {
    const q = async (t) => (await db.query(`select wallet from public.${t}`)).rows.map((r) => r.wallet);
    return { codes: await q('inbox_codes'), jobs: await q('inbox_jobs'), records: await q('posted_records') };
  }, { userId: user });
  const a = await seen(userA);
  assert.deepEqual(a, { codes: [A], jobs: [A], records: [A] });
  const b = await seen(userB);
  assert.deepEqual(b, { codes: [B], jobs: [B], records: [B] });
  // asking for B's row by key as A still returns nothing
  const peek = await asRole(db, 'authenticated', async () => (await db.query("select * from public.inbox_jobs where code = 'bbbbbbbbbb'")).rows, { userId: userA });
  assert.deepEqual(peek, []);
});

test('a user cannot become another wallet by editing their own user_metadata / token claims', async () => {
  const { db, B, userA } = await world();
  const claims = { user_metadata: { custom_claims: { address: B, chain: 'solana' }, address: B } };
  const rows = await asRole(db, 'authenticated', async () => (await db.query('select * from public.inbox_jobs')).rows, { userId: userA, claims });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].wallet, B);
});

test('a signed-in user with no Solana identity (e.g. email sign-in) sees nothing', async () => {
  const { db } = await world();
  const { rows } = await db.query('insert into auth.users default values returning id');
  await db.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'email', 'x@y.test', '{\"address\": \"x\"}')", [rows[0].id]);
  const got = await asRole(db, 'authenticated', async () => (await db.query('select * from public.inbox_jobs')).rows, { userId: rows[0].id });
  assert.deepEqual(got, []);
});

test('anon reads nothing private and writes nothing', async () => {
  const { db, A } = await world();
  for (const t of ['inbox_codes', 'inbox_jobs', 'posted_records']) {
    await assert.rejects(asRole(db, 'anon', () => db.query(`select * from public.${t}`)), denied, `anon select ${t}`);
  }
  const tries = [
    `insert into public.inbox_codes (code, wallet, expires_at) values ('cccccccccc', '${A}', now())`,
    "update public.inbox_jobs set status = 'limit_posted'",
    'delete from public.inbox_jobs',
    `insert into public.posted_records (record_sha256, code, wallet) values ('${sha('c')}', 'aaaaaaaaaa', '${A}')`,
    "insert into public.keeper_runs (cluster, lines_seen, overdue, marked, dry_run) values ('devnet', 0, 0, 0, true)",
    "select public.notch_job_update('aaaaaaaaaa', 'refused', 'other')",
  ];
  for (const sql of tries) await assert.rejects(asRole(db, 'anon', () => db.query(sql)), denied, sql);
});

test('a signed-in wallet cannot write either: not its own rows, not its status, not through the functions', async () => {
  const { db, A, userA } = await world();
  const tries = [
    "update public.inbox_jobs set status = 'refused', reason_code = 'other' where code = 'aaaaaaaaaa'",
    `update public.posted_records set tx_signature = '${SIG}', cluster = 'devnet', posted_at = now() where code = 'aaaaaaaaaa'`,
    'delete from public.inbox_codes',
    `insert into public.inbox_codes (code, wallet, expires_at) values ('dddddddddd', '${A}', now())`,
    "select public.notch_job_update('aaaaaaaaaa', 'received')",
    `select public.notch_attach_tx('${sha('a')}', '${SIG}', 'devnet')`,
  ];
  for (const sql of tries) await assert.rejects(asRole(db, 'authenticated', () => db.query(sql), { userId: userA }), denied, sql);
  const after = (await db.query("select status from public.inbox_jobs where code = 'aaaaaaaaaa'")).rows[0];
  assert.equal(after.status, 'limit_posted');
});

test('keeper_runs is public chain data: anon may read it, nobody but the service role writes it', async () => {
  const { db, svc } = await world();
  await svc(() => db.query("select public.notch_keeper_run('devnet', 3, 1, 1, 0, array[$1], false)", [SIG]));
  const rows = await asRole(db, 'anon', async () => (await db.query('select cluster, lines_seen, overdue, marked, tx_signatures from public.keeper_runs')).rows);
  assert.deepEqual(rows, [{ cluster: 'devnet', lines_seen: 3, overdue: 1, marked: 1, tx_signatures: [SIG] }]);
  await assert.rejects(asRole(db, 'anon', () => db.query("select public.notch_keeper_run('devnet', 0, 0, 0, 0, '{}', true)")), denied);
  await assert.rejects(svc(() => db.query("select public.notch_keeper_run('mainnet-beta', 0, 0, 0, 0, '{}', true)")), /check constraint/);
});

test('status order is enforced by the database: received -> checking -> limit_posted | refused; finished is final', async () => {
  const { db, A, svc } = await world();
  await svc(async () => {
    await db.query("select public.notch_inbox_issued('eeeeeeeeee', $1, now() + interval '1 day')", [A]);
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'checking')"), /must start as received/);
    await assert.rejects(db.query("select public.notch_job_update('zzzzzzzzzz', 'received')"), /unknown inbox code/);
    await db.query("select public.notch_job_update('eeeeeeeeee', 'received')");
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'limit_posted')"), /cannot go from received to limit_posted/);
    await db.query("select public.notch_job_update('eeeeeeeeee', 'checking')");
    // refused needs one of the fixed reason codes, never a sentence
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'refused', 'income was 5000 GHS')"), /check constraint/);
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'refused')"), /check constraint/);
    await db.query("select public.notch_job_update('eeeeeeeeee', 'refused', 'dkim_failed')");
    let row = (await db.query("select status, reason_code, attempts from public.inbox_jobs where code = 'eeeeeeeeee'")).rows[0];
    assert.deepEqual(row, { status: 'refused', reason_code: 'dkim_failed', attempts: 1 });
    await db.query("select public.notch_job_update('eeeeeeeeee', 'received')"); // a retry on the same address
    row = (await db.query("select status, reason_code, attempts from public.inbox_jobs where code = 'eeeeeeeeee'")).rows[0];
    assert.deepEqual(row, { status: 'received', reason_code: null, attempts: 2 });
    await db.query("select public.notch_job_update('eeeeeeeeee', 'checking')");
    await db.query(`select public.notch_limit_posted('eeeeeeeeee', '${sha('e')}')`);
    assert.equal((await db.query("select state from public.inbox_codes where code = 'eeeeeeeeee'")).rows[0].state, 'used');
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'refused', 'other')"), /cannot go from limit_posted/);
    await assert.rejects(db.query("select public.notch_job_update('eeeeeeeeee', 'received')"), /cannot go from limit_posted/);
  });
});

test('the devnet transaction is attached once to a record that exists, and mainnet is not a value', async () => {
  const { db, svc } = await world();
  await svc(async () => {
    await db.query(`select public.notch_attach_tx('${sha('a')}', '${SIG}', 'devnet')`);
    await db.query(`select public.notch_attach_tx('${sha('a')}', '${SIG}', 'devnet')`); // same again is fine
    await assert.rejects(db.query(`select public.notch_attach_tx('${sha('a')}', '${'6'.repeat(88)}', 'devnet')`), /different transaction/);
    await assert.rejects(db.query(`select public.notch_attach_tx('${sha('f')}', '${'7'.repeat(88)}', 'devnet')`), /no such record/);
    await assert.rejects(db.query(`select public.notch_attach_tx('${sha('b')}', '${'8'.repeat(88)}', 'mainnet')`), /check constraint/);
  });
  const row = (await db.query(`select cluster, tx_signature, posted_at is not null as posted from public.posted_records where record_sha256 = '${sha('a')}'`)).rows[0];
  assert.deepEqual(row, { cluster: 'devnet', tx_signature: SIG, posted: true });
});

test('inbox_jobs is in the realtime publication, so a phone can subscribe to it', async () => {
  const { db } = await world();
  const { rows } = await db.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime'");
  assert.deepEqual(rows.map((r) => r.tablename), ['inbox_jobs']);
});

test('the keeper cron migration is safe without pg_cron (skipped) and defines the vault-reading runner', async () => {
  const { db } = await world();
  const { rows } = await db.query("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and proname = 'run_keeper'");
  assert.equal(rows.length, 1);
  await assert.rejects(asRole(db, 'anon', () => db.query('select private.run_keeper()')), denied);
});
