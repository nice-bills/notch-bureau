// "Did this devnet transaction really post one of OUR records?" The borrower's wallet submits post_limit itself, so
// the underwriter learns the transaction signature only if someone tells it. Nobody is trusted for that: the claim is
// checked on chain. The transaction must have succeeded, must call the Notch program, and must carry (in its Ed25519
// verify instruction) a record that starts with our tag; the SHA-256 of that record is what links it to a stored
// record. The result is only ever written next to a hash the underwriter itself issued.
import bs58 from 'bs58';
import crypto from 'node:crypto';
import { RECORD_LEN, TAG } from './record.js';

export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';
export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export async function clusterOf(rpc, { localhostEndpoint = false } = {}) {
  const g = await rpc('getGenesisHash', []);
  if (g === GENESIS.devnet) return 'devnet';
  if (g === GENESIS.mainnet) throw new Error('mainnet is not supported: Notch runs on devnet only');
  if (localhostEndpoint) return 'localnet';
  throw new Error('this RPC is neither devnet nor a local validator');
}

// -> { recordSha256, wallet, cluster }  (throws a readable Error when the transaction is not a Notch post_limit)
export async function verifyPostedTx(rpc, { signature, programId, localhostEndpoint = false }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(String(signature || ''))) throw new Error('not a transaction signature');
  if (!programId) throw new Error('NOTCH_PROGRAM_ID is not configured');
  const cluster = await clusterOf(rpc, { localhostEndpoint });
  const tx = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw new Error('transaction not found (yet)');
  if (tx.meta?.err) throw new Error('that transaction failed on chain');
  const keys = tx.transaction?.message?.accountKeys || [];
  const ixs = tx.transaction?.message?.instructions || [];
  const callsProgram = ixs.some((i) => keys[i.programIdIndex] === programId);
  if (!callsProgram) throw new Error('that transaction does not call the Notch program');
  for (const i of ixs) {
    if (keys[i.programIdIndex] !== ED25519_PROGRAM) continue;
    const data = Buffer.from(bs58.decode(i.data));
    const at = data.indexOf(TAG);
    if (at < 0 || data.length < at + RECORD_LEN) continue;
    const record = data.subarray(at, at + RECORD_LEN);
    return { recordSha256: crypto.createHash('sha256').update(record).digest('hex'), wallet: bs58.encode(record.subarray(8, 40)), cluster };
  }
  throw new Error('that transaction carries no Notch record');
}
