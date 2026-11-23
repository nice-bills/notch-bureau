import { chainContext, readUnderwriter, solBalance, sweep } from './chain.ts';
import { ENCLAVE_URL } from './env.ts';
import { clearWallets, loadWallets, resetState, saveState } from './state.ts';
import { createKeyPairSignerFromBytes } from '@solana/kit';

export default async function globalSetup() {
  const { admin } = await chainContext(); // also refuses anything that is not devnet
  const bal = await solBalance(admin.address);
  if (bal < 150_000_000n) throw new Error(`admin wallet ${admin.address} has only ${Number(bal) / 1e9} SOL on devnet; need at least 0.15`);

  // Is the sealed computer on :8787 the one the program trusts? If not, no limit can ever be posted.
  const att = (await (await fetch(`${ENCLAVE_URL}/attestation`)).json()) as { underwriter: string; mode: string };
  const onChain = await readUnderwriter();
  if (att.underwriter !== onChain) {
    throw new Error(`the demo enclave at ${ENCLAVE_URL} signs with ${att.underwriter} but the program trusts ${onChain}. Start it with NOTCH_KEY_FILE=../.underwriter-key.json.`);
  }

  // Sweep wallets a crashed earlier run left behind, then start clean.
  for (const sk of loadWallets()) {
    try { await sweep(await createKeyPairSignerFromBytes(Uint8Array.from(sk))); } catch { /* best effort */ }
  }
  clearWallets();
  resetState();
  saveState({ adminSolStart: (await solBalance(admin.address)).toString() });
  console.log(`\n[e2e] devnet ok. admin ${admin.address} ${Number(bal) / 1e9} SOL, underwriter ${att.underwriter} (${att.mode})`);
}
