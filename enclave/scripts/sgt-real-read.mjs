#!/usr/bin/env node
// REAL mainnet read (no stubs, no transactions): proves the SGT reader works against live chain data.
//
//   node enclave/scripts/sgt-real-read.mjs                 # finds a holder from on-chain data, reads it, also reads a non-holder
//   node enclave/scripts/sgt-real-read.mjs <wallet>        # read one wallet
//
// How the default holder is found: an SGT mint named in Solana Mobile's docs is checked on chain (isSeekerGenesisToken), then
// its latest transaction is read (getSignaturesForAddress + getTransaction) and the owner of the 1-of-1 token balance is the
// holder. Everything here is public chain data. Read-only RPC methods only; no transaction is ever sent.
import { createSolanaRpc, address } from '@solana/kit';
import { isSeekerGenesisToken, SGT_GROUP_ADDRESS } from '@solana-mobile/skr-genesis-token';
import { createSgtReader, sgtHash, MAINNET_RPC } from '../src/sgt.js';

const endpoint = process.env.NOTCH_SGT_RPC_URL || MAINNET_RPC;
const rpc = createSolanaRpc(endpoint);
// An SGT mint named in Solana Mobile's own docs (docs.solanamobile.com/react-native/detecting-seeker-users, package README).
const KNOWN_SGT_MINT = process.env.NOTCH_KNOWN_SGT_MINT || '5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj';

const reader = createSgtReader({ endpoint });
let holder = process.argv[2];
if (!holder) {
  console.log(`1. is ${KNOWN_SGT_MINT.slice(0, 6)}... a real SGT mint? (group-member + metadata-pointer check from the mint bytes)`);
  const ok = await isSeekerGenesisToken(rpc, address(KNOWN_SGT_MINT));
  console.log('   isSeekerGenesisToken =', ok);
  if (!ok) { console.error('FAIL: the documented mint is not an SGT'); process.exit(1); }
  // getTokenLargestAccounts is blocked on free RPCs, so read the NFT's own latest transaction instead: the token balance
  // that holds exactly 1 of this mint after it names the owner. (Newest first; transactions that do not show the holder are skipped.)
  const sigs = await rpc.getSignaturesForAddress(address(KNOWN_SGT_MINT), { limit: 15 }).send();
  for (const s of sigs) {
    const tx = await rpc.getTransaction(s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }).send();
    const bal = (tx?.meta?.postTokenBalances || []).find((b) => b.mint === KNOWN_SGT_MINT && b.uiTokenAmount?.amount === '1');
    if (bal?.owner) { holder = bal.owner; break; }
  }
  if (!holder) { console.error('FAIL: could not find a holder in the mint\'s recent transactions'); process.exit(1); }
  console.log('2. holder found on chain: owner of the 1-of-1 token balance in the mint latest transaction');
}
console.log('   holder (public chain data):', holder);
const mints = await reader(holder);
console.log('3. reader(holder) ->', mints.length, 'SGT mint(s)', mints.length ? `[${mints.map((m) => `${m.slice(0, 6)}...${m.slice(-4)}`).join(', ')}]` : '');
console.log('   sgt_hash (what a Notch record would carry):', mints.length ? sgtHash(mints[0]).toString('hex') : '-');
const none = await reader('11111111111111111111111111111112');
console.log('4. a wallet with no SGT ->', none.length, 'mints (must be 0)');
console.log('   SGT group mint:', SGT_GROUP_ADDRESS);
if (!mints.length || none.length) { console.error('FAIL'); process.exit(1); }
console.log('REAL READ OK');
