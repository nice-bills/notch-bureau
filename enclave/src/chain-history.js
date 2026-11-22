import crypto from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

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
  return {
    repaidOnTime: data.readUInt32LE(72),
    frozen: data[88] === 1,
  };
}
