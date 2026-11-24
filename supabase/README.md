# Notch on Supabase: the bureau's public nervous system

Supabase does real jobs here and **holds nothing private**. The sealed underwriter stays the only thing that reads a
statement. A statement, a phone number, a name and an income amount never reach Supabase; the tables below have no
column that could hold one (a test checks the column list).

| Piece | Where | Job |
|---|---|---|
| Schema + row-level security | `migrations/20261124000001_notch_core.sql` | inbox code → wallet, live job status, SHA-256 of each posted record + devnet tx signature, keeper log |
| Hourly keeper | `functions/keeper/` + `migrations/20261124000002_keeper_cron.sql` | pg_cron → pg_net → Edge Function sends `mark_default` on overdue lines (devnet) |
| Sign in with Solana | `enclave/src/supabase-auth.js` | guards `/inbox/new`; the wallet proof is now **required by default** |
| Store adapter | `enclave/src/store.js`, `status.js` | `memory` (default, no credentials) or `supabase` |
| Phone side | `enclave/scripts/supabase-watch.mjs` | sign in with Solana, watch your own status live |
| Live check | `enclave/scripts/e2e-supabase.mjs` | end to end against the real project; skips loudly without credentials |

## What is stored (and why none of it is private)

Every column is documented in the migration. In short:

- `inbox_codes(code, wallet, state, created_at, expires_at)`: which statement address belongs to which wallet. The wallet is a public key. The code is the local part of an address the wallet was just shown; one statement per address, it expires, and the underwriter also demands a DKIM-signed MTN mail that names it.
- `inbox_jobs(code, wallet, status, reason_code, attempts, ...)`: `received → checking → limit_posted | refused`. `reason_code` is one of ten fixed words (`dkim_failed`, `wrong_inbox`, `no_income`, ...), never a sentence, so it cannot carry an amount or a number.
- `posted_records(record_sha256, code, wallet, tx_signature, cluster, ...)`: a hash of the whole signed record, 128 bytes (v2) or 160 bytes (v3, device bound) (shows that it exists, reveals no field), and the devnet transaction that posted it. The underwriter fills `tx_signature` only after it checked on chain that the transaction succeeded, calls the Notch program, and carries a record it issued (`POST /posted {"signature"}`; `cluster` can only be `devnet` or `localnet`). The check reads the Ed25519 verify instruction by its own offsets and accepts both record shapes, hashing all of the signed bytes, so a v3 (Seeker) transaction links just like a v2 one. Checked against real devnet transactions in `app/scripts/e2e-devnet.mjs` steps 12 and 13.
- `keeper_runs(...)`: counts and devnet signatures of the keeper's work. Public chain data, readable by anyone.
- Never stored: statements, emails, PDFs, phone numbers, names, income, the limit, the poll token.

**Who can do what.** A wallet signed in with Supabase Web3 auth reads only rows whose `wallet` is its own (the policy reads
`auth.identities`, not the token's `user_metadata`, which users can edit). Nobody except the service role writes, and only
through the `notch_*` functions, which also enforce the status order (a finished job cannot be reopened). `anon` can read
and write nothing private.

## Deploy to a real project

Needs the [Supabase CLI](https://supabase.com/docs/guides/cli) and a project (free tier is fine).

```bash
# 0. In the dashboard: Authentication > Sign In / Providers > Web3 Wallet > enable Solana.
#    Authentication > URL Configuration: add the site URL your app signs in from (and http://localhost:3000 for the scripts).

# 1. link and push the schema
supabase login
supabase link --project-ref <project-ref>
supabase db push                       # applies supabase/migrations/*; enables pg_net and pg_cron when the project allows it

# 2. keeper: a devnet fee payer (a throwaway key, ~0.1 SOL is plenty) kept OUTSIDE this repo
solana-keygen new --no-bip39-passphrase --outfile ~/keeper-devnet.json
solana airdrop 1 "$(solana-keygen pubkey ~/keeper-devnet.json)" -u devnet
SECRET=$(openssl rand -hex 24)
supabase secrets set KEEPER_KEYPAIR="$(cat ~/keeper-devnet.json)" KEEPER_SHARED_SECRET="$SECRET" NOTCH_PROGRAM_ID=<program id if not the default>
supabase functions deploy keeper --no-verify-jwt     # the cron job authenticates with x-keeper-secret instead

# 3. let pg_cron find the function: run once in the SQL editor (values go to Vault, not into any file)
#      select vault.create_secret('https://<project-ref>.supabase.co', 'notch_project_url');
#      select vault.create_secret('<the same $SECRET>',               'notch_keeper_secret');
#    pg_cron then calls it at minute 0 of every hour. To try it now:  select private.run_keeper();
#    and look at:  select * from net._http_response order by id desc limit 3;   select * from keeper_runs order by id desc;

# 4. dry run the function by hand (no key needed, sends nothing)
curl -X POST https://<project-ref>.supabase.co/functions/v1/keeper -H "x-keeper-secret: $SECRET" -H 'content-type: application/json' -d '{}'
```

The underwriter is pointed at the project with environment variables (secrets stay in env, never in git):

```
NOTCH_STORE=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # write key: only the underwriter holds it
SUPABASE_ANON_KEY=...           # public; used to ask Supabase Auth who a token belongs to
```

Without these it runs exactly as before (memory store, wallet-signature proof). For the Phala CVM, add the same names
to `SEALED_ENV` in `deploy/phala/build-compose.mjs` and to the compose file; that changes the compose hash, so do it
deliberately. It is **not done yet**.

## The phone

```js
const { data } = await supabase.auth.signInWithWeb3({ chain: 'solana', statement: 'Sign in to Notch' }); // window.solana
const token = data.session.access_token;
const res = await fetch(`${UNDERWRITER}/inbox/new`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ wallet }) });
supabase.channel('status').on('postgres_changes',
  { event: '*', schema: 'public', table: 'inbox_jobs', filter: `wallet=eq.${wallet}` },
  ({ new: row }) => show(row.status))
  .subscribe(async (state) => {
    // received -> checking -> limit_posted. Do NOT rely on catching every event: a cold channel can miss the first ones
    // (seen live, one run in three). The moment the channel says SUBSCRIBED, read the current row(s) and show those.
    if (state !== 'SUBSCRIBED') return;
    const { data } = await supabase.from('inbox_jobs').select('*').eq('wallet', wallet).order('updated_at');
    for (const row of data || []) show(row.status);
  });
```

**The phone must never depend on catching every Realtime event.** Subscribe first, then read the current row once the channel reports
`SUBSCRIBED`: whatever happened before the subscription was live is in that read, whatever happens after arrives as an event, and nothing
can fall between the two. The screen shows the newest of them (compare `updated_at`; an older row never replaces a newer one).
`enclave/scripts/supabase-watch.mjs` is the reference (`watchJobs`); `enclave/test/supabase-watch.test.js` replays the lost-event case.

`/inbox/new` also takes the optional Seeker proof (`"device": {nonce, signature, signedMessage}`, the same Sign-in-with-Solana proof
`/underwrite` takes; get a challenge from `POST /device/nonce`). It is bound to that inbox address and used when the statement arrives.
Non-Seekers simply leave it out.

From a terminal: `node enclave/scripts/supabase-watch.mjs [--keypair id.json] [--until-done]`. Without Supabase, `/inbox/new`
still works with the wallet signature (`{wallet, ts, signature}` over `notch-inbox-v1|<wallet>|<ts>`).

## Tests

```bash
pnpm test:enclave                      # includes everything below; no Supabase credentials needed
node enclave/scripts/e2e-supabase.mjs  # live project; prints a loud SKIPPED banner and exits 0 without enclave/.env.supabase
```

Run for real, offline:

- `enclave/test/supabase-schema.test.js`: the real migrations in an embedded Postgres (PGlite): wallet A cannot read wallet B's rows, a user cannot become another wallet through `user_metadata`, anon cannot read or write, a signed-in wallet cannot write, the status order, fixed reason codes, no mainnet value, Realtime publication, column allow-list.
- `enclave/test/supabase-store.test.js`: memory and Postgres stores follow the same rules; the REST client's requests; env selection.
- `enclave/test/supabase-inbox.test.js`: the HTTP inbox end to end on both stores; "Sign in with Solana" (including a forged `user_metadata`); the on-chain transaction link; a down store never blocks underwriting.
- `enclave/test/supabase-keeper.test.js`: the Edge Function's own `lib.ts` against `app/src/notch.ts` and `app/scripts/keeper.mjs`, then full passes against a fake RPC (dry run, send, failure, cap, mainnet refusal).
- The function was also booted in real Deno 2.9 (`deno check`, then `deno run`) and answered a devnet dry run (46 credit lines read, 0 overdue); with no key it refused to send.

`app/scripts/keeper.mjs` still works unchanged (the CLI keeper); both do the same job.

## Not verified live yet (no Supabase project exists yet)

- `supabase db push` on a real project: the SQL is applied only to PGlite. pg_cron, pg_net and Vault are guarded, not run.
- The cron → Edge Function chain (`private.run_keeper`), `supabase functions deploy`, and the function's behaviour on Supabase's runtime (the Deno boot above was local).
- Web3 auth details: the shape of the Solana identity in `auth.identities` / `/auth/v1/user` (the code accepts `identity_data.address`, `identity_data.custom_claims.address`, or `provider_id = web3:solana:<address>`), and which sign-in domains the project accepts.
- Realtime delivering `postgres_changes` through the RLS policy to a signed-in wallet.
- `POST /posted` is now checked against real devnet transactions (v2 and v3) in the devnet e2e (steps 12, 13). The check reads the record from the Ed25519 instruction's own offsets.
- The Phala compose does not pass the Supabase variables yet.

`enclave/scripts/e2e-supabase.mjs` covers the first four items in one run once `enclave/.env.supabase` exists.

## Live status (Nov 24)

Project `notch-bureau` (ref `rtdjnqbgpqygjkjvrcsp`, London, free tier) is live:
- Migrations 1 to 3 are applied. Migration 3 pins `search_path` on the six write functions, which clears the security advisor warnings.
- Solana Web3 sign-in is on, and the allowed redirect list holds the localhost URLs.
- The keeper function is deployed with `supabase/deploy-keeper.sh`. The plain `functions deploy` hits a server bundler timeout on `npm:@solana/kit`. Its secrets are set, and the Vault entries exist.
- The `pg_cron` → `pg_net` → function chain was called by hand: HTTP 200, 46 lines, 0 overdue. The keeper fee payer is a throwaway devnet key holding 0.1 SOL, stored outside the repo.
- `node enclave/scripts/e2e-supabase.mjs --require` passes 19 of 19, and the keeper step passes with `KEEPER_SHARED_SECRET` set.
- One run out of three missed the first two Realtime events on a cold channel. The phone now reads its current row right after `SUBSCRIBED` (see "The phone"), so it never depends on catching every event.
