// Seeker Genesis Token (SGT): one Token-2022 NFT per Seeker phone, minted on MAINNET (it is the phone's identity).
// Docs: docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token and the SKILL.md in solana-mobile/solana-mobile-skills.
//
// READ ONLY. This module only ever calls getTokenAccountsByOwner / getMultipleAccounts / getAccountInfo on a mainnet RPC;
// it never builds, signs or sends a transaction. Notch itself runs on devnet: the check READS mainnet, the result is a
// hash inside a record that is posted on devnet.
//
// What the library checks (we do not re-implement it): a mint is an SGT only if its TokenGroupMember group AND its
// MetadataPointer are the SGT group mint, decoded from the mint bytes (never from names or off-chain metadata);
// zero-balance token accounts are skipped (a transferred SGT leaves the old account open at 0); a frozen account is
// still a valid holding; RPC failures THROW (a failure must never read as "you do not own a Seeker").
import crypto from 'node:crypto';
import { getSeekerGenesisTokens, SGT_GROUP_ADDRESS } from '@solana-mobile/skr-genesis-token';
import { address, createSolanaRpc } from '@solana/kit';

export { SGT_GROUP_ADDRESS };
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// An RPC problem (not "no token"). The caller must retry later, never treat it as "not a Seeker".
export class SgtUnavailable extends Error {}

// The identity of a phone inside a Notch record: sha256("notch-sgt" | mint), same style as the phone-number identity
// (statement.js identityHash). The mint itself never leaves the enclave. The mint is public on chain, so this hash
// hides nothing an observer could not already see; it only keeps the record small and uniform.
export function sgtHash(mint) {
  return crypto.createHash('sha256').update(`notch-sgt|${mint}`).digest();
}

// -> async (wallet: base58) => string[]  (the SGT mints that wallet holds on mainnet, ordered by member number)
export function createSgtReader({ endpoint = process.env.NOTCH_SGT_RPC_URL || MAINNET_RPC, rpc } = {}) {
  if (!rpc && /devnet|testnet|localhost|127\.0\.0\.1/i.test(endpoint)) {
    throw new Error('the SGT reader needs a MAINNET rpc: Seeker Genesis Tokens exist only on mainnet');
  }
  const client = rpc || createSolanaRpc(endpoint);
  return async (wallet) => {
    let tokens;
    try {
      tokens = await getSeekerGenesisTokens(client, address(wallet));
    } catch (e) {
      throw new SgtUnavailable(`could not read the Seeker token from the mainnet RPC (${String(e.message || e).slice(0, 120)})`);
    }
    return tokens.map((t) => String(t.mint));
  };
}
