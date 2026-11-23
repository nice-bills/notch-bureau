import { createKeyPairSignerFromBytes } from '@solana/kit';
import { chainContext, solBalance, sweep } from './chain.ts';
import { clearWallets, loadState, loadWallets } from './state.ts';

export default async function globalTeardown() {
  const { admin } = await chainContext();
  let swept = 0n;
  for (const sk of loadWallets()) {
    try { swept += await sweep(await createKeyPairSignerFromBytes(Uint8Array.from(sk))); } catch (e) { console.error(`[e2e] sweep failed: ${(e as Error).message}`); }
  }
  clearWallets();
  const start = BigInt(loadState().adminSolStart ?? '0');
  const end = await solBalance(admin.address);
  console.log(`\n[e2e] swept ${Number(swept) / 1e9} SOL back to admin.`);
  if (start > 0n) console.log(`[e2e] admin SOL ${Number(start) / 1e9} -> ${Number(end) / 1e9}  (net spent ${Number(start - end) / 1e9} SOL; rent locked in token + program accounts)`);
}
