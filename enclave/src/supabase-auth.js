// "Sign in with Solana" (Supabase Web3 auth), checked on the underwriter's side.
//
// The phone calls supabase.auth.signInWithWeb3({ chain: 'solana', ... }) and gets an access token (a JWT). It sends it
// to POST /inbox/new as `Authorization: Bearer <token>`. We do NOT trust a wallet address written inside the token:
// `user_metadata` is editable by the user. Instead we ask Supabase Auth itself (GET /auth/v1/user) who this token
// belongs to, and read the wallet from the user's `web3` identity, which Supabase created after it verified the
// wallet's signature. The wallet-signature route in Inbox.issue stays available and needs no Supabase at all.
import bs58 from 'bs58';

const isSolanaAddress = (a) => { try { return bs58.decode(String(a)).length === 32; } catch { return false; } };

// -> the Solana address of the user's web3 identity, or null. Same lookup as private.my_wallets() in the migration.
export function walletFromUser(user) {
  for (const i of user?.identities || []) {
    if (i?.provider !== 'web3') continue;
    const d = i.identity_data || {};
    const chain = d.chain ?? d.custom_claims?.chain ?? 'solana';
    if (chain !== 'solana') continue;
    const a = d.address ?? d.custom_claims?.address ?? String(i.provider_id || '').replace(/^web3:solana:/, '');
    if (isSolanaAddress(a)) return a;
  }
  return null;
}

export class SupabaseAuth {
  // `anonKey` is the project's public anon / publishable key (it is not a secret).
  constructor({ url, anonKey, fetchImpl = fetch, cacheMs = 60_000, now = () => Date.now(), timeoutMs = 5000 } = {}) {
    if (!url || !anonKey) throw new Error('SupabaseAuth needs SUPABASE_URL and SUPABASE_ANON_KEY');
    this.base = String(url).replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.fetch = fetchImpl;
    this.cacheMs = cacheMs;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cache = new Map(); // token -> { wallet, until }: in memory only, short lived
  }

  // -> wallet address, or null when the token is missing, expired, forged or not a Solana sign-in
  async walletFor(jwt) {
    const token = String(jwt || '');
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    const hit = this.cache.get(token);
    if (hit && hit.until > this.now()) return hit.wallet;
    let res;
    try {
      res = await this.fetch(`${this.base}/auth/v1/user`, {
        headers: { apikey: this.anonKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { return null; }
    if (!res.ok) return null;
    const wallet = walletFromUser(await res.json().catch(() => null));
    if (wallet) {
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(token, { wallet, until: this.now() + this.cacheMs });
    }
    return wallet;
  }
}

export function createAuthFromEnv(env = process.env, opts = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  return new SupabaseAuth({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, ...opts });
}
