import crypto from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

const DEFAULT_PROGRAM_ID = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
const ACCOUNT_DISC = crypto.createHash('sha256').update('account:CreditLine').digest().subarray(0, 8);
const encodeAddress = getAddressEncoder();

// Read the canonical Notch credit line. Missing accounts mean first-time borrowers;
// malformed or unreachable state throws so underwriting fails closed.
export async function getCreditHistory(wallet, {
  endpoint = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  programId = process.env.NOTCH_PROGRAM_ID || DEFAULT_PROGRAM_ID,
  fetchImpl = fetch,
} = {}) {
  const borrower = address(wallet);
  const program = address(programId);
  const [line] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [Buffer.from('line'), encodeAddress.encode(borrower)],
  });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [line, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`Solana RPC error: ${result.error.message || 'unknown error'}`);
  const account = result.result?.value;
  if (!account) return { repaidOnTime: 0, frozen: false };
  if (account.owner !== program.toString()) throw new Error('Credit line is owned by an unexpected program');

  const data = Buffer.from(account.data?.[0] || '', 'base64');
  if (data.length < 90 || !data.subarray(0, 8).equals(ACCOUNT_DISC)) {
    throw new Error('Credit line account data is malformed');
  }
  if (!data.subarray(8, 40).equals(Buffer.from(encodeAddress.encode(borrower)))) {
    throw new Error('Credit line belongs to a different wallet');
  }
  // Layout (after the 8 byte discriminator): wallet 8..40, limit 40..48, expiry 48..56, drawn 56..64, due 64..72, repaid_on_time
  // 72..76, repaid_late 76..80, last_nonce 80..88, defaulted 88, bump 89, borrower_deposit 90..98; then the 56 byte LineExt
  // (posted_at 98..106, last_draw_at 106..114, counted_nonce 114..122, id_hash 122..154). A short (older) line has no ext.
  const hasExt = data.length >= 154;
  const idHash = hasExt ? data.subarray(122, 154) : null;
  return {
    repaidOnTime: data.readUInt32LE(72),
    frozen: data[88] === 1,
    drawn: data.length >= 98 ? data.readBigUInt64LE(56) : 0n,
    due: data.length >= 98 ? Number(data.readBigInt64LE(64)) : 0,
    // the mobile-money account the program pinned to this wallet (audit #10); null = none pinned yet
    idHash: idHash && idHash.some((b) => b !== 0) ? Buffer.from(idHash) : null,
  };
}

// Which wallet (if any) the program has already bound to a PDA of the form [seed, hash]: IdentityLink ["identity", id_hash]
// and DeviceLink ["device", device_hash] have the same layout (8 byte discriminator | wallet[32] | bump). null = unbound.
// Throws on RPC trouble or a malformed account so underwriting fails closed.
async function linkOwner(seed, accountName, hash, {
  endpoint = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  programId = process.env.NOTCH_PROGRAM_ID || DEFAULT_PROGRAM_ID,
  fetchImpl = fetch,
} = {}) {
  const disc = crypto.createHash('sha256').update(`account:${accountName}`).digest().subarray(0, 8);
  const program = address(programId);
  const [link] = await getProgramDerivedAddress({ programAddress: program, seeds: [Buffer.from(seed), Buffer.from(hash)] });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [link, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`Solana RPC error: ${result.error.message || 'unknown error'}`);
  const account = result.result?.value;
  if (!account) return null;
  if (account.owner !== program.toString()) throw new Error(`${accountName} is owned by an unexpected program`);
  const data = Buffer.from(account.data?.[0] || '', 'base64');
  if (data.length < 41 || !data.subarray(0, 8).equals(disc)) throw new Error(`${accountName} account data is malformed`);
  return getAddressDecoder().decode(data.subarray(8, 40));
}

export const getIdentityOwner = (idHash, opts) => linkOwner('identity', 'IdentityLink', idHash, opts);
export const getDeviceOwner = (deviceHash, opts) => linkOwner('device', 'DeviceLink', deviceHash, opts);
