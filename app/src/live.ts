// Live statement status over Supabase Realtime. Optional: only when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set,
// and loaded on demand so the bundle stays lean without it. The poll of the underwriter stays the source of the signed
// record; this only shows the steps (received -> checking -> limit_posted | refused) as they happen.
//
// Never depend on catching every event (a cold channel can miss the first ones): subscribe, then read the current row
// the moment the channel is SUBSCRIBED (see supabase/README.md "The phone").
import { LIVE_STATUS, SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

export type JobStatus = 'received' | 'checking' | 'limit_posted' | 'refused';
export interface JobRow { code: string; status: JobStatus; reason_code: string | null; updated_at: string }

type Client = import('@supabase/supabase-js').SupabaseClient;
let client: Promise<Client> | null = null;
const getClient = () =>
  (client ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: true } })));

/** Sign in with Solana (one wallet signature). Returns the access token the underwriter accepts for /inbox/new. */
export async function signInWithSolana(wallet: string, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<string> {
  if (!LIVE_STATUS) throw new Error('Live status is not configured.');
  const sb = await getClient();
  const { data: cur } = await sb.auth.getSession();
  if (cur.session && walletOf(cur.session.user) === wallet) return cur.session.access_token;
  const { data, error } = await sb.auth.signInWithWeb3({
    chain: 'solana',
    statement: 'Sign in to Notch. This does not move any funds.',
    wallet: { publicKey: { toBase58: () => wallet }, signMessage } as never,
    options: { url: window.location.origin },
  });
  if (error || !data.session) throw new Error(`Sign in with Solana failed: ${error?.message ?? 'no session'}`);
  return data.session.access_token;
}

function walletOf(user: { identities?: { identity_data?: Record<string, unknown> }[] } | null): string | null {
  const d = user?.identities?.[0]?.identity_data as { address?: string; custom_claims?: { address?: string } } | undefined;
  return d?.address ?? d?.custom_claims?.address ?? null;
}

/** Watch this wallet's job rows. Returns a stop function. `onRow` sees only rows for `code` and never an older one. */
export function watchJobs(wallet: string, code: string, onRow: (r: JobRow) => void, onError: (m: string) => void): () => void {
  let stopped = false;
  let last = 0;
  let stop = () => { stopped = true; };
  const see = (r: JobRow) => {
    if (stopped || r.code !== code) return;
    const at = Date.parse(r.updated_at) || 0;
    if (at && at < last) return;
    last = at;
    onRow(r);
  };
  getClient().then((sb) => {
    if (stopped) return;
    const ch = sb
      .channel(`notch-status-${code}`)
      .on('postgres_changes' as never, { event: '*', schema: 'public', table: 'inbox_jobs', filter: `wallet=eq.${wallet}` }, (p: { new: JobRow }) => see(p.new))
      .subscribe(async (state: string) => {
        if (state === 'SUBSCRIBED') {
          const { data, error } = await sb.from('inbox_jobs').select('*').eq('code', code);
          if (error) onError('Could not read the live status. Still checking the sealed computer directly.');
          for (const r of (data ?? []) as JobRow[]) see(r);
        }
        if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') onError('The live status dropped. Still checking the sealed computer directly.');
      });
    stop = () => { stopped = true; void sb.removeChannel(ch); };
  }, () => onError('Could not load the live status. Still checking the sealed computer directly.'));
  return () => stop();
}
