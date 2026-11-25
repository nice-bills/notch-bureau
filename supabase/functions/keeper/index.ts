// Supabase Edge Function (Deno): the hourly keeper. pg_cron + pg_net call it (supabase/migrations/..._keeper_cron.sql);
// it finds overdue credit lines on devnet and sends mark_default. app/scripts/keeper.mjs is the same job as a CLI.
//
// Secrets (set with `supabase secrets set`, never committed):
//   KEEPER_KEYPAIR         the fee payer's secret key, a JSON array of 64 numbers (`solana-keygen new` file contents)
//   KEEPER_SHARED_SECRET   what the cron job sends in the x-keeper-secret header
//   NOTCH_PROGRAM_ID       optional, defaults to the devnet deployment
//   SOLANA_RPC_URL         optional, defaults to https://api.devnet.solana.com
// Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself.
//
// Without {"send": true} in the body it is a DRY RUN: it lists what it would mark and sends nothing.
import { Buffer } from 'node:buffer';
import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { DEFAULT_PROGRAM_ID, keeperPass } from './lib.ts';

// The bundled @solana/kit (node build) calls a bare `Buffer` when it encodes a transaction and a request URL. Deno has no global
// Buffer, so the first real `send` died with "Buffer is not defined" (found by the live e2e, step 14). The functions only read
// `Buffer` when called, long after this line has run.
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || !a) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function recordRun(r: { cluster: string; linesSeen: number; overdue: number; marked: number; failed: number; signatures: string[]; dryRun: boolean }) {
  const base = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return;
  await fetch(`${base}/rest/v1/rpc/notch_keeper_run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ p_cluster: r.cluster, p_lines: r.linesSeen, p_overdue: r.overdue, p_marked: r.marked, p_failed: r.failed, p_sigs: r.signatures, p_dry: r.dryRun }),
  }).catch((e) => console.error('keeper_runs write failed:', (e as Error)?.message));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, reason: 'POST only' });
  if (!safeEqual(req.headers.get('x-keeper-secret') ?? '', env('KEEPER_SHARED_SECRET'))) return json(401, { ok: false, reason: 'bad or missing x-keeper-secret' });
  const body = await req.json().catch(() => ({}));
  const send = body?.send === true;
  try {
    const rpcUrl = env('SOLANA_RPC_URL') || 'https://api.devnet.solana.com';
    const payer = send ? await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(env('KEEPER_KEYPAIR') || '[]'))) : undefined;
    const logs: string[] = [];
    const result = await keeperPass({
      rpc: createSolanaRpc(rpcUrl), rpcUrl, program: env('NOTCH_PROGRAM_ID') || DEFAULT_PROGRAM_ID, payer, send,
      log: (m) => { logs.push(m); console.log(m); },
    });
    await recordRun(result);
    return json(200, { ok: true, ...result, log: logs });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split('\n')[0];
    console.error('keeper failed:', msg);
    return json(500, { ok: false, reason: msg });
  }
});
