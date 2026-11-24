// The inbox with the Supabase layer: live status rows, hash of each record, "Sign in with Solana", reported devnet
// transactions. Runs against memory and against a real Postgres (PGlite) with the real migrations.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { MemoryStore, PgStore } from '../src/store.js';
import { SupabaseAuth, walletFromUser } from '../src/supabase-auth.js';
import { ED25519_PROGRAM, GENESIS } from '../src/chain-posted.js';
import { resolver, momoStatementEmail, randomMsisdn } from './fixtures/emails.js';
import { ed25519Data } from './fixtures/ed25519.js';
import { newDb } from '../../supabase/tests/harness.js';

const SECRET = 'test-inbound-secret';
const DOMAIN = 'inbox.example.test';
const PROGRAM = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
const servers = [];
after(() => servers.forEach((s) => s.close()));

const newWallet = () => { const kp = nacl.sign.keyPair(); return { kp, address: bs58.encode(kp.publicKey) }; };
const signedBody = ({ kp, address }) => {
  const ts = Date.now();
  return { wallet: address, ts, signature: Buffer.from(nacl.sign.detached(Buffer.from(`notch-inbox-v1|${address}|${ts}`), kp.secretKey)).toString('base64') };
};

async function boot({ store, auth = null, db } = {}) {
  const u = new Underwriter({ resolver, llm: null });
  // NO test-only escape hatch here: this is the strict Inbox a server runs.
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, store, auth });
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers });
  const newInbox = async (w, headers) => (await post('/inbox/new', signedBody(w), headers)).json();
  const inbound = (eml, rcpt) => post('/inbound', eml, { 'x-notch-rcpt': rcpt, 'x-notch-inbound-secret': SECRET });
  const record = async (w, token) => (await fetch(`${base}/record/${w.address}`, { headers: { 'x-notch-token': token } })).json();
  return { u, inbox, base, post, newInbox, inbound, record, store, db };
}

const adapters = {
  memory: async () => ({ store: new MemoryStore() }),
  postgres: async () => { const db = await newDb(PGlite); return { db, store: new PgStore({ query: (s, p) => db.query(s, p) }) }; },
};
const jobRows = async (t) => (t.db ? (await t.db.query('select code, wallet, status, reason_code as reason from public.inbox_jobs order by code')).rows
  : [...t.store.jobs].map(([code, j]) => ({ code, wallet: j.wallet, status: j.status, reason: j.reasonCode })));
const sha = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

for (const [kind, make] of Object.entries(adapters)) {
  test(`${kind}: a statement walks received -> checking -> limit_posted and only the record's hash is stored`, async () => {
    const t = await boot(await make());
    const w = newWallet();
    const { address, pollToken } = await t.newInbox(w);
    const code = address.split('@')[0];
    const msisdn = randomMsisdn();
    assert.equal((await t.inbound(await momoStatementEmail({ to: address, msisdn }), address)).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await jobRows(t), [{ code, wallet: w.address, status: 'limit_posted', reason: null }]);
    if (kind === 'memory') assert.deepEqual(t.store.log.map((l) => l.status), ['received', 'checking', 'limit_posted']);
    const rec = await t.record(w, pollToken);
    assert.equal(rec.status, 'ready');
    const stored = t.db ? (await t.db.query('select record_sha256 as h, wallet, tx_signature as tx from public.posted_records')).rows
      : [...t.store.records].map(([h, r]) => ({ h, wallet: r.wallet, tx: r.txSignature }));
    assert.deepEqual(stored, [{ h: sha(rec.message), wallet: w.address, tx: null }]);
    // the privacy claim, tested on the data itself: nothing the statement contained is anywhere in the store
    const dump = JSON.stringify(t.db
      ? await Promise.all(['inbox_codes', 'inbox_jobs', 'posted_records'].map(async (n) => (await t.db.query(`select * from public.${n}`)).rows))
      : [[...t.store.codes], [...t.store.jobs], [...t.store.records]]);
    assert.ok(!dump.includes(msisdn.replace(/\D/g, '').slice(-8)), 'no phone number');
    assert.ok(!dump.includes(pollToken), 'no poll token');
  });

  test(`${kind}: a refused statement shows refused with a coarse reason code, never the sentence`, async () => {
    const t = await boot(await make());
    const alice = newWallet();
    const mallory = newWallet();
    const a = await t.newInbox(alice);
    const m = await t.newInbox(mallory);
    const r = await t.inbound(await momoStatementEmail({ to: a.address, msisdn: randomMsisdn() }), m.address); // redirect attempt
    assert.equal(r.status, 422);
    await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(await jobRows(t), [{ code: m.address.split('@')[0], wallet: mallory.address, status: 'refused', reason: 'wrong_inbox' }]);
    // the retry on the same address works and the row goes refused -> received -> ... -> limit_posted
    const ok = await t.inbound(await momoStatementEmail({ to: m.address, msisdn: randomMsisdn() }), m.address);
    assert.equal(ok.status, 200);
    assert.equal((await jobRows(t))[0].status, 'limit_posted');
  });
}

test('a broken store does not stop a statement from being underwritten', async () => {
  const down = { kind: 'down', ...Object.fromEntries(['inboxIssued', 'inboxState', 'jobUpdate', 'limitPosted', 'attachTx', 'keeperRun'].map((k) => [k, async () => { throw new Error('connection refused'); }])) };
  const t = await boot({ store: down });
  const w = newWallet();
  const { address, pollToken } = await t.newInbox(w);
  assert.equal((await t.inbound(await momoStatementEmail({ to: address, msisdn: randomMsisdn() }), address)).status, 200);
  assert.equal((await t.record(w, pollToken)).status, 'ready');
});

// ---- Sign in with Solana -------------------------------------------------------------------------------------------

// A stand-in for GET /auth/v1/user. Tokens: "<user>.<anything>.<anything>". `metaAddress` is what the user typed into
// their own user_metadata; the identity is what Supabase verified.
function fakeSupabase(users) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const token = String(init.headers.authorization).replace(/^Bearer /, '');
    const user = users[token.split('.')[0]];
    return user ? new Response(JSON.stringify(user), { status: 200 }) : new Response('{"msg":"invalid JWT"}', { status: 401 });
  };
  return { fetchImpl, calls };
}
const web3User = (address, extra = {}) => ({ id: 'u', identities: [{ provider: 'web3', provider_id: `web3:solana:${address}`, identity_data: { address, chain: 'solana' } }], ...extra });
const token = (user) => `${user}.payload.sig`;

test('Sign in with Solana: a Supabase token for the wallet replaces the wallet signature; anything else is refused', async () => {
  const alice = newWallet();
  const mallory = newWallet();
  const fake = fakeSupabase({
    alice: web3User(alice.address),
    // mallory signed in as herself, then edited her user_metadata to claim Alice's wallet: the identity still says mallory
    mallory: web3User(mallory.address, { user_metadata: { custom_claims: { address: alice.address }, address: alice.address } }),
    emailer: { id: 'e', identities: [{ provider: 'email', identity_data: { address: alice.address } }] },
  });
  const auth = new SupabaseAuth({ url: 'https://abc.supabase.co', anonKey: 'anon-key', fetchImpl: fake.fetchImpl });
  const t = await boot({ store: new MemoryStore(), auth });
  const ask = async (body, bearer) => {
    const r = await t.post('/inbox/new', body, bearer ? { authorization: `Bearer ${bearer}` } : {});
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await ask({ wallet: alice.address }, token('alice'))).status, 200);
  assert.equal(fake.calls[0].url, 'https://abc.supabase.co/auth/v1/user');
  assert.equal(fake.calls[0].init.headers.apikey, 'anon-key');
  assert.equal((await ask({ wallet: alice.address })).status, 401, 'no token, no signature');
  assert.equal((await ask({ wallet: alice.address }, token('mallory'))).status, 401, 'metadata cannot make mallory alice');
  assert.equal((await ask({ wallet: alice.address }, token('emailer'))).status, 401, 'an email sign-in is not a wallet');
  assert.equal((await ask({ wallet: alice.address }, token('nobody'))).status, 401, 'unknown token');
  assert.equal((await ask({ wallet: alice.address }, 'not-a-jwt')).status, 401);
  assert.equal((await ask({ wallet: mallory.address }, token('alice'))).status, 401, 'alice cannot ask for mallory');
  assert.equal((await ask(signedBody(alice))).status, 200, 'the wallet signature still works on its own');
  // a bearer token on a server without Supabase is refused, not ignored
  const bare = await boot({ store: new MemoryStore() });
  const r = await bare.post('/inbox/new', { wallet: alice.address }, { authorization: `Bearer ${token('alice')}` });
  assert.equal(r.status, 401);
});

test('SupabaseAuth caches a good token briefly and never trusts an unreachable Supabase', async () => {
  const w = newWallet();
  let t = 1000;
  const fake = fakeSupabase({ a: web3User(w.address) });
  const auth = new SupabaseAuth({ url: 'https://abc.supabase.co', anonKey: 'k', fetchImpl: fake.fetchImpl, now: () => t, cacheMs: 100 });
  assert.equal(await auth.walletFor(token('a')), w.address);
  assert.equal(await auth.walletFor(token('a')), w.address);
  assert.equal(fake.calls.length, 1);
  t += 200;
  await auth.walletFor(token('a'));
  assert.equal(fake.calls.length, 2);
  const down = new SupabaseAuth({ url: 'https://abc.supabase.co', anonKey: 'k', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await down.walletFor(token('a')), null);
  assert.equal(walletFromUser({ identities: [{ provider: 'web3', identity_data: { custom_claims: { address: w.address, chain: 'solana' } } }] }), w.address);
  assert.equal(walletFromUser({ identities: [{ provider: 'web3', identity_data: { address: w.address, chain: 'ethereum' } }] }), null);
  assert.equal(walletFromUser({ identities: [{ provider: 'web3', provider_id: 'web3:solana:not-an-address' }] }), null);
});

// ---- the devnet transaction -----------------------------------------------------------------------------------------

function fakeChain({ record, genesis = GENESIS.devnet, program = PROGRAM, err = null }) {
  const edData = ed25519Data(record);
  const tx = { meta: { err }, transaction: { message: { accountKeys: ['payer', ED25519_PROGRAM, program], instructions: [{ programIdIndex: 1, data: bs58.encode(edData) }, { programIdIndex: 2, data: bs58.encode(Buffer.from('x')) }] } } };
  return async (method) => (method === 'getGenesisHash' ? genesis : method === 'getTransaction' ? tx : null);
}

test('a reported devnet transaction is linked only if the chain shows it carries a record we issued', async () => {
  const store = new MemoryStore();
  const t = await boot({ store });
  const w = newWallet();
  const { address, pollToken } = await t.newInbox(w);
  assert.equal((await t.inbound(await momoStatementEmail({ to: address, msisdn: randomMsisdn() }), address)).status, 200);
  const rec = await t.record(w, pollToken);
  const message = Buffer.from(rec.message, 'base64');
  const SIG = '3'.repeat(88);
  const report = async (rpc, signature = SIG) => {
    t.inbox.chainRpc = rpc;
    const r = await t.post('/posted', { signature });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await report(fakeChain({ record: message }), 'short')).status, 422);
  assert.equal((await report(fakeChain({ record: message, genesis: GENESIS.mainnet }))).status, 422, 'mainnet refused');
  assert.equal((await report(fakeChain({ record: message, genesis: 'SomethingElse' }))).status, 422, 'unknown cluster refused');
  assert.equal((await report(fakeChain({ record: message, program: 'OtherProgram' }))).status, 422, 'not the Notch program');
  assert.equal((await report(fakeChain({ record: message, err: { InstructionError: [0, 'Custom'] } }))).status, 422, 'failed tx');
  const foreign = Buffer.from(message); foreign[60] ^= 1; // a record this underwriter never issued
  assert.equal((await report(fakeChain({ record: foreign }))).status, 404);
  const ok = await report(fakeChain({ record: message }));
  assert.deepEqual(ok, { status: 200, body: { ok: true, cluster: 'devnet' } });
  assert.deepEqual([...store.records.values()].map((r) => [r.txSignature, r.cluster]), [[SIG, 'devnet']]);
  assert.equal((await t.post('/posted', 'nope')).status, 400);
});
