// DEMO / DEVNET ONLY: a tiny faucet so a judge with a fresh wallet can try Notch without a script.
// POST /demo/faucet {"wallet": "<address>"} sends a little SOL (network fees) and test USDC (minted: the faucet key is the
// test USDC mint authority). It refuses mainnet (checked by genesis hash), limits each wallet to one drip per 10 minutes
// and the whole faucet to 40 drips an hour.
import fs from 'node:fs';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DRIP = { sol: 20_000_000n, usdc: 100_000_000n }; // 0.02 SOL (fees + account rent), 100 test USDC

export async function createFaucet({ keypairFile, rpcUrl, mint, perWalletS = 600, perHour = 40 }) {
  if (!keypairFile || !fs.existsSync(keypairFile) || !rpcUrl || !mint) return null;
  const rpc = createSolanaRpc(rpcUrl);
  const genesis = await rpc.getGenesisHash().send().catch(() => null);
  if (!genesis || genesis === MAINNET_GENESIS) return null;
  const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keypairFile, 'utf8'))));
  const mintAddr = address(mint);
  const last = new Map();
  let hour = { start: Date.now(), n: 0 };

  async function drip(wallet) {
    let owner;
    try { owner = address(String(wallet || '').trim()); } catch { return { status: 400, body: { ok: false, reason: 'That is not a wallet address.' } }; }
    const now = Date.now();
    if (now - hour.start > 3_600_000) hour = { start: now, n: 0 };
    const prev = last.get(owner);
    if (prev && now - prev < perWalletS * 1000) return { status: 429, body: { ok: false, reason: `This wallet got test money ${Math.round((now - prev) / 60000)} min ago. Try again in ${Math.ceil((perWalletS * 1000 - (now - prev)) / 60000)} min.` } };
    if (hour.n >= perHour) return { status: 429, body: { ok: false, reason: 'The test faucet is busy. Try again in a few minutes.' } };
    last.set(owner, now);
    hour.n++;
    try {
      const [ata] = await findAssociatedTokenPda({ owner, mint: mintAddr, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const ixs = [
        getTransferSolInstruction({ source: admin, destination: owner, amount: lamports(DRIP.sol) }),
        getCreateAssociatedTokenIdempotentInstruction({ payer: admin, ata, owner, mint: mintAddr }),
        getMintToInstruction({ mint: mintAddr, token: ata, mintAuthority: admin, amount: DRIP.usdc }),
      ];
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const tx = await pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(admin, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
        (m) => signTransactionMessageWithSigners(m),
      );
      const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
      for (let i = 0; i < 60; i++) {
        const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
        if (st?.err) throw new Error(`faucet transaction failed: ${JSON.stringify(st.err)}`);
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
          return { status: 200, body: { ok: true, signature, sol: "0.02", usdc: '100' } };
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      throw new Error('faucet transaction not confirmed in time');
    } catch (e) {
      last.delete(owner);
      return { status: 502, body: { ok: false, reason: `The test faucet could not send: ${e instanceof Error ? e.message : String(e)}` } };
    }
  }
  return { admin: admin.address, drip };
}
