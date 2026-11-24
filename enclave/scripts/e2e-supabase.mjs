#!/usr/bin/env node
// END-TO-END against the LIVE Supabase project (devnet money only; no mainnet anywhere).
//
//   node enclave/scripts/e2e-supabase.mjs            # skips loudly, exit 0, when there are no credentials
//   node enclave/scripts/e2e-supabase.mjs --require  # same, but exit 1 when there are no credentials
//
// Credentials come from enclave/.env.supabase (git-ignored) or the environment:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY            required
//   NOTCH_WEB3_URL            the site URL written into the sign-in message (must be allowed in Authentication > URL
//                             Configuration), default http://localhost:3000
//   KEEPER_SHARED_SECRET      optional: also calls the deployed `keeper` function as a dry run
//
// What it proves, with two real "Sign in with Solana" users and the real underwriter code:
//   1  both wallets sign in with Solana (Supabase Web3 auth)
//   2  /inbox/new refuses a request with no proof, and with another wallet's token; accepts the wallet's own token
//   3  the phone (wallet A) subscribes to Realtime and sees received -> checking -> limit_posted live
//   4  RLS on the live project: A sees its rows, B sees none of A's, anon sees nothing and cannot write, A cannot write
//   5  the stored hash equals the SHA-256 of the signed record, and no private value is in any table
//   6  the keeper function answers a dry run (when KEEPER_SHARED_SECRET is set)
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Underwriter, DEFAULT_TRUSTED } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { SupabaseStore } from '../src/store.js';
import { SupabaseAuth } from '../src/supabase-auth.js';
import * as fixtures from '../test/fixtures/emails.js';
import { loadSupabaseEnv, newWallet, signInWithSolana } from './supabase-lib.mjs';
import { watchJobs } from './supabase-watch.mjs';

const env = loadSupabaseEnv();
const need = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env[k]);
if (need.length) {
  const bar = '#'.repeat(78);
  console.log(`\n${bar}\n#  SKIPPED: e2e-supabase did NOT run. Missing: ${need.join(', ')}\n#  Put them in enclave/.env.supabase (git-ignored; template: supabase/env.example), then run again.\n#  Nothing about the Supabase layer was verified against a live project by this run.\n${bar}\n`);
  process.exit(process.argv.includes('--require') ? 1 : 0);
}

const results = [];
const step = (id, title) => console.log(`\n=== ${id}. ${title}`);
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = env.SUPABASE_URL.replace(/\/+$/, '');
const service = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const SECRET = crypto.randomBytes(16).toString('hex');
const DOMAIN = 'inbox.notch.test';
let server; const users = []; let walletAddrs = [];
let failure = null;

try {
  step('1', 'two wallets sign in with Solana (Supabase Web3 auth)');
  const A = newWallet(); const B = newWallet(); walletAddrs = [A.address, B.address];
  const sa = await signInWithSolana(env, A);
  const sb = await signInWithSolana(env, B);
  users.push(sa.user.id, sb.user.id);
  check('wallet A has a session', !!sa.session?.access_token, A.address);
  check('wallet B has a session', !!sb.session?.access_token, B.address);

  step('2', 'the underwriter (strict inbox, Supabase store + auth) guards /inbox/new');
  const u = new Underwriter({ resolver: fixtures.resolver, trusted: [...DEFAULT_TRUSTED], llm: null });
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, store: new SupabaseStore({ url, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }), auth: new SupabaseAuth({ url, anonKey: env.SUPABASE_ANON_KEY }) });
  server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (wallet, bearer) => { const r = await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify({ wallet }), headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }); return { status: r.status, ...(await r.json()) }; };
  check('no proof -> 401', (await ask(A.address)).status === 401);
  check("A's token cannot ask for B's wallet -> 401", (await ask(B.address, sa.session.access_token)).status === 401);
  const inb = await ask(A.address, sa.session.access_token);
  check("A's own token -> an inbox address", inb.status === 200 && inb.ok, inb.address);
  const code = inb.address.split('@')[0];

  step('3', 'Realtime: the phone sees the statement move (and does not depend on catching every event)');
  // The phone's own code path (watchJobs): subscribe, then read the current row right after SUBSCRIBED. A cold channel can drop the
  // first events (seen live, about one run in three), so this checks what the PHONE shows, not that every event arrived.
  const seen = [];
  const watching = watchJobs({ supabase: sa.supabase, wallet: A.address, untilDone: true, onRow: (row) => seen.push(row.status) });
  const subscribed = new Promise((resolve) => { const t = setInterval(() => { if (sa.supabase.getChannels().some((c) => c.state === 'joined')) { clearInterval(t); resolve(); } }, 50); });
  await Promise.race([subscribed, sleep(10_000)]);
  const eml = await fixtures.momoStatementEmail({ to: inb.address, msisdn: fixtures.randomMsisdn() });
  const r = await fetch(`${base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': inb.address, 'x-notch-inbound-secret': SECRET } });
  check('the statement was accepted', r.status === 200, `HTTP ${r.status}`);
  await Promise.race([watching, sleep(15_000)]);
  const rank = { received: 1, checking: 2, limit_posted: 3 };
  const forward = seen.every((st, i) => i === 0 || rank[st] >= rank[seen[i - 1]]);
  check('the phone ends on limit_posted and never shows a step backwards (events or the read after SUBSCRIBED)', seen.at(-1) === 'limit_posted' && forward, seen.join(' > '));
  await sa.supabase.removeAllChannels();

  step('4', 'row-level security on the live project');
  const mine = await sa.supabase.from('inbox_jobs').select('*');
  check('A reads its own job', !mine.error && mine.data.length === 1 && mine.data[0].code === code && mine.data[0].status === 'limit_posted');
  const theirs = await sb.supabase.from('inbox_jobs').select('*');
  check("B reads none of A's rows", !theirs.error && theirs.data.length === 0);
  const peek = await sb.supabase.from('inbox_jobs').select('*').eq('code', code);
  check("B asking for A's code by name gets nothing", !peek.error && peek.data.length === 0);
  for (const t of ['inbox_codes', 'inbox_jobs', 'posted_records']) {
    const q = await anon.from(t).select('*');
    check(`anon reads nothing from ${t}`, !!q.error || q.data.length === 0, q.error?.message || '0 rows');
  }
  const w1 = await anon.from('inbox_jobs').insert({ code, wallet: A.address, status: 'limit_posted' });
  check('anon cannot insert', !!w1.error, w1.error?.message);
  const w2 = await sa.supabase.from('inbox_jobs').update({ status: 'refused', reason_code: 'other' }).eq('code', code).select();
  check('A cannot update its own job', !!w2.error || (w2.data || []).length === 0, w2.error?.message || '0 rows changed');
  const w3 = await sa.supabase.rpc('notch_job_update', { p_code: code, p_status: 'received' });
  check('A cannot call the write functions', !!w3.error, w3.error?.message);
  const after = await service.from('inbox_jobs').select('status').eq('code', code).single();
  check('the job is still limit_posted', after.data?.status === 'limit_posted');

  step('5', 'what is stored: a hash, and nothing private');
  const rec = await (await fetch(`${base}/record/${A.address}`, { headers: { 'x-notch-token': inb.pollToken } })).json();
  const hash = crypto.createHash('sha256').update(Buffer.from(rec.message, 'base64')).digest('hex');
  const pr = await service.from('posted_records').select('*').eq('code', code);
  check('posted_records holds the SHA-256 of the signed record', pr.data?.length === 1 && pr.data[0].record_sha256 === hash && pr.data[0].tx_signature === null);
  const dump = JSON.stringify([(await service.from('inbox_codes').select('*').eq('code', code)).data, mine.data, pr.data]);
  check('no poll token, no phone number, no limit in the stored rows', !dump.includes(inb.pollToken) && !/\b0\d{9}\b|\+?233\d{9}/.test(dump) && !dump.includes('limitUsdc'));

  step('6', 'the hourly keeper function');
  if (env.KEEPER_SHARED_SECRET) {
    const kr = await fetch(`${url}/functions/v1/keeper`, { method: 'POST', headers: { 'x-keeper-secret': env.KEEPER_SHARED_SECRET, 'content-type': 'application/json', authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }, body: JSON.stringify({ send: false }) });
    const kb = await kr.json().catch(() => ({}));
    check('keeper dry run answers on devnet', kr.status === 200 && kb.ok && kb.dryRun === true && kb.cluster === 'devnet', `${kb.linesSeen} line(s), ${kb.overdue} overdue`);
    const runs = await anon.from('keeper_runs').select('*').order('id', { ascending: false }).limit(1);
    check('anyone can read the keeper_runs log', !runs.error && runs.data.length === 1, runs.error?.message);
  } else console.log('  SKIPPED: set KEEPER_SHARED_SECRET to call the deployed keeper function');
} catch (e) {
  failure = e;
  console.error(`\nERROR: ${e.stack || e.message}`);
} finally {
  // clean up everything this run created
  try {
    for (const w of walletAddrs) await service.from('inbox_codes').delete().eq('wallet', w); // cascades to jobs and records
    for (const id of users) await service.auth.admin.deleteUser(id);
  } catch (e) { console.error(`cleanup problem: ${e.message}`); }
  server?.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failure ? ' (run aborted by an error)' : ''}`);
process.exit(failed.length || failure ? 1 : 0);
