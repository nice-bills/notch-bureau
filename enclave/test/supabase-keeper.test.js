// The Edge Function keeper's logic (supabase/functions/keeper/lib.ts, the same file Deno runs) checked against the
// app's own decoders and builders, then driven end to end with a fake RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { address, generateKeyPairSigner, getAddressEncoder, getBase64Decoder } from '@solana/kit';
import * as keeper from '../../supabase/functions/keeper/lib.ts';
import * as app from '../../app/src/notch.ts';
import { selectOverdue as cliSelectOverdue } from '../../app/scripts/keeper.mjs';

const enc = getAddressEncoder();
const PROGRAM = keeper.DEFAULT_PROGRAM_ID;
const sha8 = (s) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);

function lineBytes({ wallet = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', drawn = 0n, due = 0n, defaulted = false } = {}) {
  const d = Buffer.alloc(app.CREDIT_LINE_MIN_LEN);
  LINE_DISC.copy(d, 0);
  Buffer.from(enc.encode(address(wallet))).copy(d, 8);
  d.writeBigUInt64LE(50_000_000n, 40);
  d.writeBigInt64LE(2_000_000_000n, 48);
  d.writeBigUInt64LE(drawn, 56);
  d.writeBigInt64LE(due, 64);
  d[88] = defaulted ? 1 : 0;
  return new Uint8Array(d);
}
const LINE_DISC = Buffer.from(sha8('account:CreditLine'));

test('keeper constants match the program: discriminators, line length, pool address, instruction bytes', async () => {
  assert.deepEqual([...keeper.LINE_DISCRIMINATOR], [...sha8('account:CreditLine')]);
  assert.deepEqual([...keeper.MARK_DEFAULT_DISCRIMINATOR], [...sha8('global:mark_default')]);
  assert.deepEqual([...keeper.MARK_DEFAULT_DISCRIMINATOR], [...app.discriminator('mark_default')]);
  assert.equal(keeper.CREDIT_LINE_MIN_LEN, app.CREDIT_LINE_MIN_LEN);
  const a = await app.deriveAddresses(address(PROGRAM), address(PROGRAM));
  assert.equal(await keeper.poolAddress(PROGRAM), a.pool);
  const line = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
  const mine = keeper.markDefaultInstruction(PROGRAM, a.pool, line);
  const theirs = app.markDefaultIx(a, address(line));
  assert.deepEqual(mine.accounts, theirs.accounts);
  assert.deepEqual([...mine.data], [...theirs.data]);
  assert.equal(mine.programAddress, theirs.programAddress);
});

test('keeper decoding and selection agree with app/src/notch.ts and app/scripts/keeper.mjs', () => {
  const now = 1_000_000n;
  const cases = [
    { drawn: 5_000_000n, due: 999_999n }, { drawn: 5_000_000n, due: 1_000_000n }, { drawn: 5_000_000n, due: 1_000_001n },
    { drawn: 0n, due: 10n }, { drawn: 5_000_000n, due: 0n }, { drawn: 5_000_000n, due: 10n, defaulted: true },
  ];
  const accounts = cases.map((c, i) => ({ pubkey: `line${i}`, data: lineBytes(c) })).concat([{ pubkey: 'garbage', data: new Uint8Array(10) }]);
  const mine = keeper.selectOverdue(accounts, now).map((o) => o.pubkey);
  assert.deepEqual(mine, ['line0']);
  assert.deepEqual(mine, cliSelectOverdue(accounts, now).map((o) => o.pubkey));
  for (const a of accounts.slice(0, 6)) {
    const x = keeper.decodeLine(a.data);
    const y = app.decodeLine(a.data);
    assert.deepEqual([x.wallet, x.drawn, x.due, x.defaulted], [y.wallet, y.drawn, y.due, y.defaulted]);
    assert.equal(keeper.isPastDue(x, now), app.isPastDue(y, now));
  }
});

// ---- a fake RPC ---------------------------------------------------------------------------------------------------
function fakeRpc({ lines, genesis = keeper.DEVNET_GENESIS, failTx = new Set() }) {
  const sent = [];
  const b64 = getBase64Decoder();
  const call = (fn) => (...a) => ({ send: async () => fn(...a) });
  const rpc = {
    getGenesisHash: call(() => genesis),
    getProgramAccounts: call(() => lines.map((l) => ({ pubkey: l.pubkey, account: { data: [b64.decode(l.data), 'base64'] } }))),
    getSlot: call(() => 100n),
    getBlockTime: call(() => 1_000_000n),
    getLatestBlockhash: call(() => ({ value: { blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4', lastValidBlockHeight: 1000n } })),
    sendTransaction: call((wire) => {
      const sig = `sig${sent.length}`.padEnd(88, '1');
      sent.push({ wire, sig });
      return sig;
    }),
    getSignatureStatuses: call(([sig]) => ({ value: [failTx.has(sig) ? { err: { InstructionError: [0, 'Custom'] } } : { confirmationStatus: 'confirmed', err: null }] })),
  };
  return { rpc, sent };
}
const lineAccounts = () => [
  { pubkey: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', data: lineBytes({ drawn: 5_000_000n, due: 10n }) },
  { pubkey: '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz', data: lineBytes({ drawn: 5_000_000n, due: 5_000_000n }) }, // not due yet
  { pubkey: 'Sysvar1nstructions1111111111111111111111111', data: lineBytes({ drawn: 5_000_000n, due: 10n, defaulted: true }) },
];

test('a dry run lists what it would mark and sends nothing', async () => {
  const { rpc, sent } = fakeRpc({ lines: lineAccounts() });
  const r = await keeper.keeperPass({ rpc, rpcUrl: 'https://api.devnet.solana.com', program: PROGRAM, send: false });
  assert.deepEqual([r.cluster, r.linesSeen, r.overdue, r.marked, r.dryRun], ['devnet', 3, 1, 0, true]);
  assert.equal(sent.length, 0);
});

test('send mode marks only the overdue line, with a real signed transaction carrying mark_default', async () => {
  const { rpc, sent } = fakeRpc({ lines: lineAccounts() });
  const payer = await generateKeyPairSigner();
  const r = await keeper.keeperPass({ rpc, rpcUrl: 'https://api.devnet.solana.com', program: PROGRAM, payer, send: true, pollMs: 1 });
  assert.deepEqual([r.overdue, r.marked, r.failed, r.signatures], [1, 1, 0, [sent[0].sig]]);
  assert.equal(sent.length, 1);
  const wire = Buffer.from(sent[0].wire, 'base64');
  assert.ok(wire.includes(Buffer.from(keeper.MARK_DEFAULT_DISCRIMINATOR)), 'the instruction data is mark_default');
  assert.ok(wire.includes(Buffer.from(enc.encode(address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')))), 'it names the overdue line');
  assert.ok(wire.includes(Buffer.from(enc.encode(payer.address))), 'signed by the fee payer');
});

test('one failing transaction is counted and the next line is still tried; the cap per run holds', async () => {
  const many = Array.from({ length: 12 }, () => ({ pubkey: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', data: lineBytes({ drawn: 1n, due: 10n }) }));
  const { rpc, sent } = fakeRpc({ lines: many, failTx: new Set([`sig0`.padEnd(88, '1')]) });
  const payer = await generateKeyPairSigner();
  const r = await keeper.keeperPass({ rpc, rpcUrl: 'https://api.devnet.solana.com', program: PROGRAM, payer, send: true, pollMs: 1 });
  assert.equal(r.overdue, 12);
  assert.equal(sent.length, keeper.MAX_SENDS_PER_RUN);
  assert.deepEqual([r.failed, r.marked, r.skipped], [1, 9, 2]);
});

test('mainnet and unknown clusters are refused, and sending needs a fee payer', async () => {
  const dev = 'https://api.devnet.solana.com';
  await assert.rejects(keeper.keeperPass({ rpc: fakeRpc({ lines: [] }).rpc, rpcUrl: 'https://api.mainnet-beta.solana.com', program: PROGRAM, send: false }), /mainnet/);
  await assert.rejects(keeper.keeperPass({ rpc: fakeRpc({ lines: [], genesis: keeper.MAINNET_GENESIS }).rpc, rpcUrl: 'https://rpc.example.com', program: PROGRAM, send: false }), /mainnet/);
  await assert.rejects(keeper.keeperPass({ rpc: fakeRpc({ lines: [], genesis: 'Other' }).rpc, rpcUrl: 'https://rpc.example.com', program: PROGRAM, send: false }), /not devnet/);
  const local = await keeper.keeperPass({ rpc: fakeRpc({ lines: [], genesis: 'Other' }).rpc, rpcUrl: 'http://127.0.0.1:8899', program: PROGRAM, send: false });
  assert.equal(local.cluster, 'localnet');
  await assert.rejects(keeper.keeperPass({ rpc: fakeRpc({ lines: [] }).rpc, rpcUrl: dev, program: PROGRAM, send: true }), /fee payer/);
});
