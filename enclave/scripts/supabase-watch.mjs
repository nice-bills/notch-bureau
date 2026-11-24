#!/usr/bin/env node
// What a phone does: sign in with Solana, subscribe to your own statement status, print it live.
//
//   node scripts/supabase-watch.mjs                      # a fresh throwaway wallet (prints its address)
//   node scripts/supabase-watch.mjs --keypair ~/.config/solana/id.json
//   node scripts/supabase-watch.mjs --until-done         # exit after limit_posted or refused
//
// Needs SUPABASE_URL and SUPABASE_ANON_KEY (public keys) in enclave/.env.supabase or the environment.
// Row-level security means the stream only ever contains YOUR rows.
import fs from 'node:fs';
import { loadSupabaseEnv, newWallet, signInWithSolana, walletFromSecret } from './supabase-lib.mjs';

const WORDS = { received: 'statement received', checking: 'checking it', limit_posted: 'limit posted', refused: 'refused' };
export const describe = (row) => `${WORDS[row.status] || row.status}${row.reason_code ? ` (${row.reason_code})` : ''}`;

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const env = loadSupabaseEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) { console.error('SUPABASE_URL and SUPABASE_ANON_KEY are needed (enclave/.env.supabase)'); process.exit(1); }
  const keyFile = arg('--keypair');
  const wallet = keyFile ? walletFromSecret(JSON.parse(fs.readFileSync(keyFile, 'utf8'))) : newWallet();
  const untilDone = argv.includes('--until-done');
  const { supabase } = await signInWithSolana(env, wallet);
  console.log(`signed in as ${wallet.address}`);

  const { data: existing } = await supabase.from('inbox_jobs').select('*').order('updated_at');
  for (const row of existing || []) console.log(`${new Date(row.updated_at).toISOString()}  ${row.code}  ${describe(row)}`);

  await new Promise((resolve, reject) => {
    supabase.channel('notch-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_jobs', filter: `wallet=eq.${wallet.address}` }, ({ new: row }) => {
        console.log(`${new Date().toISOString()}  ${row.code}  ${describe(row)}`);
        if (untilDone && (row.status === 'limit_posted' || row.status === 'refused')) resolve();
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') console.log('watching... (Ctrl-C to stop)');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error(status));
      });
  });
  await supabase.removeAllChannels();
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
