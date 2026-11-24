// Shared helpers for the two Supabase scripts: read the git-ignored env file, and "Sign in with Solana" from Node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = path.join(here, '..', '.env.supabase'); // git-ignored (.env.* in .gitignore)

// KEY=value lines; the process environment wins over the file.
export function loadSupabaseEnv(file = ENV_FILE) {
  const out = {};
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SUPABASE_|NOTCH_|KEEPER_)/.test(k))) };
}

export function walletFromSecret(secret64) {
  const kp = nacl.sign.keyPair.fromSecretKey(Uint8Array.from(secret64));
  return { kp, address: bs58.encode(kp.publicKey) };
}
export function newWallet() {
  const kp = nacl.sign.keyPair();
  return { kp, address: bs58.encode(kp.publicKey) };
}

// supabase.auth.signInWithWeb3({ chain: 'solana' }) with a wallet object that signs in Node (a phone has window.solana).
// `siteUrl` is the domain written into the sign-in message; Supabase checks it against the project's URL settings.
export async function signInWithSolana(env, wallet, { siteUrl = env.NOTCH_WEB3_URL || 'http://localhost:3000' } = {}) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.signInWithWeb3({
    chain: 'solana',
    statement: 'Sign in to Notch. This does not move any funds.',
    wallet: {
      publicKey: { toBase58: () => wallet.address },
      signMessage: async (message) => nacl.sign.detached(message, wallet.kp.secretKey),
    },
    options: { url: siteUrl },
  });
  if (error) throw new Error(`Sign in with Solana failed: ${error.message}`);
  return { supabase, session: data.session, user: data.user };
}
