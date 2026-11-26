#!/usr/bin/env node
// One-off, DEVNET ONLY: give the test USDC mint a Metaplex token-metadata account so wallets (Phantom) show
// "Test USDC" with an icon instead of "Unknown Token". Creates it, or updates it if it already exists.
//
//   node scripts/usdc-metadata.mjs --mint <addr> --uri https://<your-app>/test-usdc.json [--send]
//
// The signer must be the mint authority (the same key devnet-setup.mjs used, default ~/.config/solana/id.json).
// The metadata stays mutable with that key as update authority, so --uri can be re-pointed later
// (e.g. once the app has a permanent URL). Nothing is sent without --send.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const METADATA_PROGRAM = address('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };

const o = { rpc: 'https://api.devnet.solana.com', keypair: path.join(os.homedir(), '.config/solana/id.json'), name: 'Test USDC', symbol: 'USDC' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i] ?? fail(`${a} needs a value`);
  if (a === '--mint') o.mint = next();
  else if (a === '--uri') o.uri = next();
  else if (a === '--rpc') o.rpc = next();
  else if (a === '--keypair') o.keypair = next();
  else if (a === '--name') o.name = next();
  else if (a === '--symbol') o.symbol = next();
  else if (a === '--send') o.send = true;
  else fail(`unknown option ${a}`);
}
if (!o.mint || !o.uri) fail('usage: --mint <address> --uri <https://…/test-usdc.json> [--send]');
if (/mainnet/i.test(o.rpc)) fail('devnet only.');

const rpc = createSolanaRpc(o.rpc);
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(o.keypair, 'utf8'))));
const mint = address(o.mint);
const enc = getAddressEncoder();
const [metadata] = await getProgramDerivedAddress({
  programAddress: METADATA_PROGRAM,
  seeds: [new TextEncoder().encode('metadata'), enc.encode(METADATA_PROGRAM), enc.encode(mint)],
});

// Borsh helpers
const u8 = (n) => Uint8Array.of(n);
const u16 = (n) => Uint8Array.of(n & 0xff, n >> 8);
const str = (s) => { const b = new TextEncoder().encode(s); const l = new Uint8Array(4); new DataView(l.buffer).setUint32(0, b.length, true); return [l, b]; };
const cat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
// DataV2 { name, symbol, uri, seller_fee_basis_points, creators: None, collection: None, uses: None }
const dataV2 = [...str(o.name), ...str(o.symbol), ...str(o.uri), u16(0), u8(0), u8(0), u8(0)];

const signer = (role) => ({ address: payer.address, role, signer: payer });
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) fail(`this RPC is not devnet (genesis ${genesis}).`);
const info = (await rpc.getAccountInfo(mint, { encoding: 'jsonParsed' }).send()).value;
const authority = info?.data?.parsed?.info?.mintAuthority;
if (authority !== payer.address) fail(`the mint authority is ${authority}, not this key (${payer.address}).`);
const exists = !!(await rpc.getAccountInfo(metadata, { encoding: 'base64' }).send()).value;

const ix = exists
  ? { // UpdateMetadataAccountV2 (15): Some(data), None new authority, None primary sale, Some(true) mutable
      programAddress: METADATA_PROGRAM,
      accounts: [{ address: metadata, role: AccountRole.WRITABLE }, signer(AccountRole.READONLY_SIGNER)],
      data: cat([u8(15), u8(1), ...dataV2, u8(0), u8(0), u8(1), u8(1)]),
    }
  : { // CreateMetadataAccountV3 (33): data, is_mutable = true, collection_details = None
      programAddress: METADATA_PROGRAM,
      accounts: [
        { address: metadata, role: AccountRole.WRITABLE },
        { address: mint, role: AccountRole.READONLY },
        signer(AccountRole.READONLY_SIGNER), // mint authority
        signer(AccountRole.WRITABLE_SIGNER), // payer
        signer(AccountRole.READONLY_SIGNER), // update authority
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: cat([u8(33), ...dataV2, u8(1), u8(0)]),
    };

console.log(`mint      ${mint}\nmetadata  ${metadata} (${exists ? 'exists: update' : 'new: create'})\nname      ${o.name} / ${o.symbol}\nuri       ${o.uri}`);
if (!o.send) { console.log('[dry run] add --send to send it.'); process.exit(0); }

const { value: bh } = await rpc.getLatestBlockhash().send();
const tx = await pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
  (m) => appendTransactionMessageInstructions([ix], m),
  (m) => signTransactionMessageWithSigners(m),
);
const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
for (let i = 0; i < 60; i++) {
  const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
  if (st?.err) fail(`failed on chain: ${JSON.stringify(st.err)}  ${sig}`);
  if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') { console.log(`ok        ${sig}`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));
}
fail(`not confirmed after 60s (${sig})`);
