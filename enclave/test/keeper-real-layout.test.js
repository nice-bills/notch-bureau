// Audit finding #1 (CRITICAL): the keeper never saw a current credit line, because it filtered on dataSize 98 while the
// program writes longer lines. The old keeper test passed because it built a hand-written 98-byte buffer.
// THIS test builds the account with the REAL program (LiteSVM runs target/deploy/notch.so), takes the exact bytes the
// chain would return, and runs both keepers' real account queries against a fake RPC that applies getProgramAccounts
// filters (dataSize and memcmp) the way a validator does. If the program's layout changes, or a size filter comes back,
// this fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { generateKeyPairSigner, getBase64Decoder } from '@solana/kit';
import * as keeper from '../../supabase/functions/keeper/lib.ts';
import * as cli from '../../app/scripts/keeper.mjs';
import * as L from '../../tests/lib.js';

const b64 = getBase64Decoder();

// What a validator does with getProgramAccounts filters.
function applyFilters(accounts, filters = []) {
  return accounts.filter(({ data }) => filters.every((f) => {
    if (f.dataSize !== undefined) return BigInt(data.length) === BigInt(f.dataSize);
    if (f.memcmp) {
      assert.equal(f.memcmp.encoding, 'base58');
      const off = Number(f.memcmp.offset);
      const want = Buffer.from(bs58.decode(f.memcmp.bytes));
      return data.length >= off + want.length && Buffer.from(data).subarray(off, off + want.length).equals(want);
    }
    throw new Error(`unsupported filter ${JSON.stringify(f)}`);
  }));
}

function fakeRpc({ accounts, now }) {
  const sent = [];
  const call = (fn) => (...a) => ({ send: async () => fn(...a) });
  const rpc = {
    getGenesisHash: call(() => keeper.DEVNET_GENESIS),
    getProgramAccounts: call((_program, cfg) => applyFilters(accounts, cfg.filters).map((a) => ({ pubkey: a.pubkey, account: { data: [b64.decode(a.data), 'base64'] } }))),
    getSlot: call(() => 100n),
    getBlockTime: call(() => BigInt(now)),
    getLatestBlockhash: call(() => ({ value: { blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4', lastValidBlockHeight: 1000n } })),
    sendTransaction: call((wire) => { const sig = `sig${sent.length}`.padEnd(88, '1'); sent.push({ wire, sig }); return sig; }),
    getSignatureStatuses: call(() => ({ value: [{ confirmationStatus: 'confirmed', err: null }] })),
  };
  return { rpc, sent };
}

// A real overdue loan, produced by the real program: draw_with_term(10 s), then let it lapse.
async function realOverdueLine() {
  const ctx = await L.setup({ borrowerFunds: 100n * L.USDC });
  await L.open(ctx, 50);
  assert.ok((await L.sendB(ctx, L.depositBorrowerIx(ctx, 4n * L.USDC))).ok);
  assert.ok((await L.sendB(ctx, L.drawWithTermIx(ctx, 10n * L.USDC, 10))).ok);
  L.advance(ctx, 11);
  const acct = ctx.svm.getAccount(ctx.line);
  return { ctx, data: Uint8Array.from(acct.data), now: Number(ctx.svm.getClock().unixTimestamp), pubkey: ctx.line };
}

test('the line the CURRENT program builds is read by the Edge Function keeper (and is not 98 bytes)', async () => {
  const { data, now, pubkey } = await realOverdueLine();
  assert.ok(data.length > keeper.CREDIT_LINE_MIN_LEN, `a current line is ${data.length} bytes; a 98 byte size filter can never match it`);
  const { rpc } = fakeRpc({ accounts: [{ pubkey, data }], now });
  const r = await keeper.keeperPass({ rpc, rpcUrl: 'https://api.devnet.solana.com', program: keeper.DEFAULT_PROGRAM_ID, send: false });
  assert.equal(r.linesSeen, 1, 'the keeper must see the line');
  assert.equal(r.overdue, 1, 'and see that it is overdue');
});

test('the real line is matched by the CLI keeper filter too, and old shorter lines still are', async () => {
  const { data, now } = await realOverdueLine();
  assert.equal(typeof cli.lineFilters, 'function');
  const accounts = [
    { pubkey: 'current', data },
    { pubkey: 'legacy106', data: data.slice(0, 106) },
    { pubkey: 'legacy98', data: data.slice(0, 98) },
    { pubkey: 'not-a-line', data: Uint8Array.from({ length: 160 }, (_, i) => i) },
  ];
  for (const [who, filters] of [['cli', cli.lineFilters()], ['edge', keeper.lineFilters()]]) {
    const hit = applyFilters(accounts, filters).map((a) => a.pubkey);
    assert.deepEqual(hit, ['current', 'legacy106', 'legacy98'], `${who} keeper filter`);
    assert.ok(!filters.some((f) => f.dataSize !== undefined), `${who}: no dataSize filter, ever`);
  }
  const picked = cli.selectOverdue(applyFilters(accounts, cli.lineFilters()), now).map((p) => p.pubkey);
  assert.deepEqual(picked, ['current', 'legacy106', 'legacy98']);
});

test('full pass: the keeper sends mark_default for a real overdue line and the real program accepts it', async () => {
  const { ctx, data, now, pubkey } = await realOverdueLine();
  const payer = await generateKeyPairSigner();
  const { rpc, sent } = fakeRpc({ accounts: [{ pubkey, data }], now });
  const r = await keeper.keeperPass({ rpc, rpcUrl: 'https://api.devnet.solana.com', program: keeper.DEFAULT_PROGRAM_ID, payer, send: true, pollMs: 1 });
  assert.equal(r.marked, 1);
  assert.equal(sent.length, 1);
  // The very instruction the keeper builds is what the program runs: send it into LiteSVM.
  const ix = keeper.markDefaultInstruction(keeper.DEFAULT_PROGRAM_ID, await keeper.poolAddress(keeper.DEFAULT_PROGRAM_ID), pubkey);
  const m = await L.send(ctx.svm, ctx.borrower, [ix]);
  assert.ok(m.ok, m.logs);
  assert.equal(L.readLine(ctx.svm, ctx.line).defaulted, true);
});
