import fs from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { chainContext, readUnderwriterConfig, solBalance, sweep } from './chain.ts';
import { ENCLAVE_KEY_FILE, ENCLAVE_URL } from './env.ts';
import { restoreUnderwriter, rotateToLocal } from './rotation.ts';
import { clearWallets, loadWallets, resetState, saveState } from './state.ts';

export default async function globalSetup() {
  const { admin } = await chainContext(); // also refuses anything that is not devnet
  const bal = await solBalance(admin.address);
  if (bal < 150_000_000n) throw new Error(`admin wallet ${admin.address} has only ${Number(bal) / 1e9} SOL on this network; need at least 0.15`);

  // The program is only ever pointed at the key in the local key file: never at whatever answers on ENCLAVE_URL.
  const att = (await (await fetch(`${ENCLAVE_URL}/attestation`)).json()) as { underwriter: string; mode: string };
  const local = (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ENCLAVE_KEY_FILE, 'utf8'))))).address;
  if (att.underwriter !== local) {
    throw new Error(`the demo enclave at ${ENCLAVE_URL} signs with ${att.underwriter} but ${ENCLAVE_KEY_FILE} holds ${local}. Start it with NOTCH_KEY_FILE=../.underwriter-key.json.`);
  }
  const config = await readUnderwriterConfig();
  if (config.admin !== admin.address) throw new Error(`the program's admin is ${config.admin}, not ${admin.address}: cannot rotate the underwriter`);

  // Global teardown does not run when setup fails, and Playwright does not handle SIGTERM/SIGHUP: restore in both cases here.
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => void restoreUnderwriter().finally(() => process.exit(1)));
  }
  try {
    await rotateToLocal(local);

    // Sweep wallets a crashed earlier run left behind, then start clean.
    for (const sk of loadWallets()) {
      try { await sweep(await createKeyPairSignerFromBytes(Uint8Array.from(sk))); } catch { /* best effort */ }
    }
    clearWallets();
    resetState();
    saveState({ adminSolStart: (await solBalance(admin.address)).toString() });
  } catch (e) {
    await restoreUnderwriter();
    throw e;
  }
  console.log(`\n[e2e] chain ok. admin ${admin.address} ${Number(bal) / 1e9} SOL, underwriter ${local} (${att.mode})`);
}
