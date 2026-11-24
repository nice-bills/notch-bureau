#!/usr/bin/env node
// What a phone does: sign in with Solana, subscribe to your own statement status, print it live.
//
//   node scripts/supabase-watch.mjs                      # a fresh throwaway wallet (prints its address)
//   node scripts/supabase-watch.mjs --keypair ~/.config/solana/id.json
//   node scripts/supabase-watch.mjs --until-done         # exit after limit_posted or refused
//
// Needs SUPABASE_URL and SUPABASE_ANON_KEY (public keys) in enclave/.env.supabase or the environment.
// Row-level security means the stream only ever contains YOUR rows.
//
// THE PHONE MUST NOT DEPEND ON CATCHING EVERY REALTIME EVENT. A cold channel can miss events that happen while it is still
// joining (seen on the live project: one run in three lost the first two). So `watchJobs` does two things: it subscribes,
// and the moment the channel says SUBSCRIBED it reads the current row(s) with a plain select. Anything that happened before
// the subscription was live is in that read; anything after arrives as an event. The screen shows the latest of the two.
import fs from 'node:fs';
import { loadSupabaseEnv, newWallet, signInWithSolana, walletFromSecret } from './supabase-lib.mjs';

const WORDS = { received: 'statement received', checking: 'checking it', limit_posted: 'limit posted', refused: 'refused' };
export const describe = (row) => `${WORDS[row.status] || row.status}${row.reason_code ? ` (${row.reason_code})` : ''}`;
export const isDone = (row) => row.status === 'limit_posted' || row.status === 'refused';

// Watches the signed-in wallet's inbox_jobs. `onRow(row, from)` gets every row, `from` is 'read' (the select right after
// SUBSCRIBED) or 'event' (Realtime). A stale event never moves a code backwards: rows are ordered by updated_at per code.
// Resolves when `untilDone` and a row is finished; otherwise runs until `signal` aborts. Rejects on a channel error.
export async function watchJobs({ supabase, wallet, onRow, untilDone = false, onSubscribed = () => {}, signal } = {}) {
  const latest = new Map(); // code -> updated_at (ms)
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, v) => { if (!finished) { finished = true; fn(v); } };
    const see = (row, from) => {
      const at = Date.parse(row.updated_at || '') || 0;
      if (at && at < (latest.get(row.code) ?? 0)) return; // older than what we already showed
      latest.set(row.code, at);
      onRow(row, from);
      if (untilDone && isDone(row)) finish(resolve);
    };
    supabase.channel('notch-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_jobs', filter: `wallet=eq.${wallet}` }, ({ new: row }) => see(row, 'event'))
      .subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          onSubscribed();
          // the current state, read AFTER the subscription is live: nothing can fall between the read and the stream
          const { data, error } = await supabase.from('inbox_jobs').select('*').eq('wallet', wallet).order('updated_at');
          if (error) return finish(reject, new Error(`could not read the current status: ${error.message}`));
          for (const row of data || []) see(row, 'read');
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish(reject, err || new Error(status));
      });
    signal?.addEventListener('abort', () => finish(resolve));
  });
}

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

  await watchJobs({
    supabase, wallet: wallet.address, untilDone,
    onSubscribed: () => console.log('watching... (Ctrl-C to stop)'),
    onRow: (row, from) => console.log(`${new Date(row.updated_at || Date.now()).toISOString()}  ${row.code}  ${describe(row)}${from === 'read' ? '  (current)' : ''}`),
  });
  await supabase.removeAllChannels();
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
