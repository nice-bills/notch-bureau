// Superteam Earn has no fixed payer wallet, so a payout email alone proves nothing on chain and a transfer
// alone does not say "Earn". The proof is both: a DKIM-signed Earn email naming an amount, AND a USDC credit of
// that amount to the borrower's own token account within +-7 days of the email.
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const PAYOUT_WINDOW_S = 7 * 86400;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOLERANCE = 0.005; // same 0.5% Earn itself allows between listed and paid amount
const PAGE = 100;
const MAX_PAGES = 5;
const enc = getAddressEncoder();

// JSON-RPC over fetch. Returns `(method, params) => result`, which is what tests replace with a fake.
export function makeRpc({ endpoint = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', fetchImpl = fetch } = {}) {
  return async (method, params) => {
    let last;
    for (let i = 0; i < 4; i++) {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) { last = new Error(`Solana RPC returned HTTP ${res.status}`); await new Promise((r) => setTimeout(r, 600 * (i + 1))); continue; }
      if (!res.ok) throw new Error(`Solana RPC returned HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`Solana RPC error: ${body.error.message || 'unknown error'}`);
      return body.result;
    }
    throw last;
  };
}

export async function usdcAccountOf(wallet, mint) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(wallet)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(mint))],
  });
  return ata;
}

// Net USDC the wallet gained in one parsed transaction (raw units, bigint). A transaction in which the wallet
// also LOST USDC from another of its own accounts is a self-transfer, not income.
export function netCredit(tx, wallet, mint) {
  const bal = (list) => (list || []).filter((b) => b.mint === mint && b.owner === wallet);
  const pre = bal(tx?.meta?.preTokenBalances);
  const post = bal(tx?.meta?.postTokenBalances);
  let gained = 0n;
  for (const p of post) {
    const before = pre.find((b) => b.accountIndex === p.accountIndex);
    const delta = BigInt(p.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0');
    if (delta < 0n) return 0n; // the wallet sent USDC in this very transaction
    gained += delta;
  }
  return gained;
}

const near = (got, want) => {
  const diff = got > want ? got - want : want - got;
  return diff * 1000n <= want * BigInt(Math.round(TOLERANCE * 1000));
};

// Find a transaction that credited `wallet` ~`amountUsdc` USDC within the window around `at`.
// `exclude` is a Set of signatures already spent on another email. `hint` is a signature quoted by the email.
export async function findUsdcReceipt({ wallet, amountUsdc, at, mint = USDC_MINT_MAINNET, rpc, exclude = new Set(), hint, windowS = PAYOUT_WINDOW_S }) {
  const want = BigInt(Math.round(amountUsdc * 1e6));
  const lo = Math.floor(at.getTime() / 1000) - windowS;
  const hi = Math.floor(at.getTime() / 1000) + windowS;
  const check = async (signature) => {
    if (exclude.has(signature)) return null;
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || tx.meta?.err || !tx.blockTime || tx.blockTime < lo || tx.blockTime > hi) return null;
    const got = netCredit(tx, wallet, mint);
    return got > 0n && near(got, want) ? { signature, blockTime: tx.blockTime, amountMicro: got } : null;
  };
  if (hint) {
    const hit = await check(hint);
    if (hit) return hit;
  }
  const account = await usdcAccountOf(wallet, mint);
  let before;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await rpc('getSignaturesForAddress', [account, { limit: PAGE, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    if (!sigs?.length) return null;
    for (const s of sigs) {
      if (s.err || !s.blockTime || s.blockTime > hi) continue;
      if (s.blockTime < lo) return null; // newest first: everything after this is older still
      const hit = await check(s.signature);
      if (hit) return hit;
    }
    if (sigs.length < PAGE) return null;
    before = sigs[sigs.length - 1].signature;
  }
  return null;
}

// A transaction signature quoted in the email text (base58, 80-90 chars). Only a hint: the chain decides.
export function signatureIn(text) {
  return String(text).match(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/)?.[0] || null;
}
