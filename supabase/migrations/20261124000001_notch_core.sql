-- Notch bureau: the public nervous system. It holds NOTHING private.
--
-- WHAT IS NEVER STORED HERE (and why the claim is checkable: read the columns below)
--   * statements, emails, PDFs      -> only the sealed underwriter ever reads those
--   * phone numbers, names          -> not a single column can hold one
--   * income amounts, the limit     -> not stored; only a SHA-256 hash of the signed record
--   * the poll token                -> stays inside the underwriter (it is what unlocks the record itself)
--
-- WHO CAN DO WHAT
--   * a wallet signed in with Supabase "Sign in with Solana" (auth.identities provider 'web3') READS only rows whose
--     `wallet` is its own address (row-level security, below);
--   * only the underwriter's service role WRITES, and only through the notch_* functions at the bottom, which also
--     enforce the status order (a finished job cannot be reopened);
--   * anon (not signed in) can read and write nothing, except keeper_runs, which is public chain data.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Which wallets does the signed-in user own? Read from auth.identities (written by Supabase after it verified the
-- wallet's signature), NOT from the JWT's user_metadata, because a user can edit their own user_metadata.
-- SECURITY DEFINER because `authenticated` cannot read the auth schema.
create or replace function private.my_wallets() returns setof text
language sql stable security definer set search_path = '' as $$
  select coalesce(
           i.identity_data ->> 'address',
           i.identity_data -> 'custom_claims' ->> 'address',
           regexp_replace(i.provider_id, '^web3:solana:', ''))
    from auth.identities i
   where i.user_id = (select auth.uid())
     and i.provider = 'web3'
     and coalesce(i.identity_data ->> 'chain', i.identity_data -> 'custom_claims' ->> 'chain', 'solana') = 'solana'
$$;
revoke all on function private.my_wallets() from public, anon;
grant execute on function private.my_wallets() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- inbox_codes: which statement address belongs to which wallet.
--   code        10 random base32 characters: the local part of <code>@<inbox domain>. Not private from the wallet that
--               owns it (that wallet was just shown the full address). Single use, expires. A leaked code alone
--               cannot be abused: the underwriter also demands a DKIM-signed MTN mail that names this very address.
--   wallet      the Solana address (a public key; public on-chain anyway).
--   state       open | used | locked | expired. A word, nothing about the statement.
--   created_at / expires_at   timestamps of the address itself.
create table public.inbox_codes (
  code        text primary key check (code ~ '^[a-z2-7]{10}$'),
  wallet      text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  state       text not null default 'open' check (state in ('open', 'used', 'locked', 'expired')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index inbox_codes_wallet_idx on public.inbox_codes (wallet);

-- inbox_jobs: the live status of one statement, what the phone watches over Realtime.
--   code         the inbox address this job is for (1 row per address, updated in place)
--   wallet       copy of the owner, so row-level security (and Realtime) is a plain column compare
--   status       received -> checking -> limit_posted | refused   (a word, nothing about the statement)
--   reason_code  only when refused: one of a short fixed list. Never free text, so it cannot carry an amount, a
--                number or a sentence from the email.
--   attempts     how many deliveries this address has seen (a refused address can be retried a few times)
--   created_at / updated_at   timestamps
create table public.inbox_jobs (
  code         text primary key references public.inbox_codes (code) on delete cascade,
  wallet       text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  status       text not null check (status in ('received', 'checking', 'limit_posted', 'refused')),
  reason_code  text check (reason_code in (
                 'dkim_failed', 'wrong_inbox', 'no_statement', 'unreadable', 'no_income',
                 'already_counted', 'identity_conflict', 'locked', 'expired', 'other')),
  attempts     int not null default 1 check (attempts between 1 and 20),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((status = 'refused') = (reason_code is not null))
);
create index inbox_jobs_wallet_idx on public.inbox_jobs (wallet);

-- posted_records: one row per signed record the underwriter issued.
--   record_sha256  SHA-256 of the 128-byte signed record. A hash, so the table shows THAT a record exists and lets
--                  anyone holding the record check it, but it does not reveal the limit or any field. The record
--                  already carries a fresh nonce and the per-email dedupe hash, so the limit cannot be guessed back.
--   code / wallet  the inbox address and its owner
--   tx_signature   the devnet transaction that posted the record on chain. Filled later, after the underwriter itself
--                  checked on chain that this transaction really carries this record. Public chain data.
--   cluster        'devnet' or 'localnet'. There is no mainnet value on purpose.
--   created_at / posted_at   when issued / when seen on chain
create table public.posted_records (
  record_sha256  text primary key check (record_sha256 ~ '^[0-9a-f]{64}$'),
  code           text not null references public.inbox_codes (code) on delete cascade,
  wallet         text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  tx_signature   text unique check (tx_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,100}$'),
  cluster        text check (cluster in ('devnet', 'localnet')),
  created_at     timestamptz not null default now(),
  posted_at      timestamptz,
  check ((tx_signature is null) = (cluster is null) and (tx_signature is null) = (posted_at is null))
);
create index posted_records_wallet_idx on public.posted_records (wallet);

-- keeper_runs: what the hourly keeper did. Only public chain data (counts and devnet transaction signatures),
-- so anyone may read it: it is the proof that the keeper really runs.
--   ran_at, cluster, lines_seen (credit lines on chain), overdue (past due and unmarked), marked (mark_default sent),
--   failed (sends that failed), tx_signatures (the mark_default transactions), dry_run (nothing was sent)
create table public.keeper_runs (
  id             bigint generated always as identity primary key,
  ran_at         timestamptz not null default now(),
  cluster        text not null check (cluster in ('devnet', 'localnet')),
  lines_seen     int not null check (lines_seen >= 0),
  overdue        int not null check (overdue >= 0),
  marked         int not null check (marked >= 0),
  failed         int not null default 0 check (failed >= 0),
  tx_signatures  text[] not null default '{}',
  dry_run        boolean not null
);

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security. Supabase grants every role everything on new public tables by default; take it all back first.
alter table public.inbox_codes    enable row level security;
alter table public.inbox_jobs     enable row level security;
alter table public.posted_records enable row level security;
alter table public.keeper_runs    enable row level security;
revoke all on public.inbox_codes, public.inbox_jobs, public.posted_records, public.keeper_runs from public, anon, authenticated;
revoke all on sequence public.keeper_runs_id_seq from public, anon, authenticated;

grant select on public.inbox_codes, public.inbox_jobs, public.posted_records to authenticated;
grant select on public.keeper_runs to anon, authenticated;
grant all on public.inbox_codes, public.inbox_jobs, public.posted_records, public.keeper_runs to service_role;
grant usage, select on sequence public.keeper_runs_id_seq to service_role;

create policy "a wallet reads only its own inbox codes" on public.inbox_codes
  for select to authenticated using (wallet in (select private.my_wallets()));
create policy "a wallet reads only its own jobs" on public.inbox_jobs
  for select to authenticated using (wallet in (select private.my_wallets()));
create policy "a wallet reads only its own records" on public.posted_records
  for select to authenticated using (wallet in (select private.my_wallets()));
create policy "keeper runs are public chain data" on public.keeper_runs
  for select to anon, authenticated using (true);
-- No insert/update/delete policy exists for anon or authenticated, and they hold no such privilege: writes are denied.
-- service_role bypasses row-level security by design.

-- Realtime: the phone subscribes to its own inbox_jobs rows (Realtime applies the policy above to every event).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.inbox_jobs;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- The only write path. Callable by the service role only (the underwriter holds that key).

create function public.notch_inbox_issued(p_code text, p_wallet text, p_expires timestamptz) returns void
language sql as $$
  insert into public.inbox_codes (code, wallet, expires_at) values (p_code, p_wallet, p_expires)
  on conflict (code) do nothing
$$;

create function public.notch_inbox_state(p_code text, p_state text) returns void
language plpgsql as $$
begin
  update public.inbox_codes set state = p_state where code = p_code and state <> 'used';
end $$;

-- status order: (new) -> received -> checking -> limit_posted | refused ; refused -> received (a retry); limit_posted is final
create function public.notch_job_update(p_code text, p_status text, p_reason text default null) returns void
language plpgsql as $$
declare
  w text;
  cur text;
begin
  select wallet into w from public.inbox_codes where code = p_code;
  if w is null then raise exception 'unknown inbox code' using errcode = 'P0002'; end if;
  select status into cur from public.inbox_jobs where code = p_code for update;
  if cur is null then
    if p_status <> 'received' then raise exception 'a job must start as received' using errcode = '22023'; end if;
    insert into public.inbox_jobs (code, wallet, status) values (p_code, w, 'received');
  elsif (cur, p_status) in (('received', 'checking'), ('received', 'refused'), ('checking', 'limit_posted'), ('checking', 'refused')) then
    update public.inbox_jobs set status = p_status, reason_code = case when p_status = 'refused' then p_reason end, updated_at = now() where code = p_code;
  elsif (cur, p_status) = ('refused', 'received') then
    update public.inbox_jobs set status = 'received', reason_code = null, attempts = attempts + 1, updated_at = now() where code = p_code;
  else
    raise exception 'job cannot go from % to %', cur, p_status using errcode = '22023';
  end if;
  if p_status = 'limit_posted' then update public.inbox_codes set state = 'used' where code = p_code; end if;
end $$;

-- limit_posted + the record hash, atomically
create function public.notch_limit_posted(p_code text, p_record_sha256 text) returns void
language plpgsql as $$
declare w text;
begin
  perform public.notch_job_update(p_code, 'limit_posted');
  select wallet into w from public.inbox_codes where code = p_code;
  insert into public.posted_records (record_sha256, code, wallet) values (p_record_sha256, p_code, w) on conflict do nothing;
end $$;

create function public.notch_attach_tx(p_record_sha256 text, p_tx_signature text, p_cluster text) returns void
language plpgsql as $$
begin
  update public.posted_records set tx_signature = p_tx_signature, cluster = p_cluster, posted_at = now()
   where record_sha256 = p_record_sha256 and (tx_signature is null or tx_signature = p_tx_signature);
  if not found then raise exception 'no such record, or it already has a different transaction' using errcode = 'P0002'; end if;
end $$;

create function public.notch_keeper_run(p_cluster text, p_lines int, p_overdue int, p_marked int, p_failed int, p_sigs text[], p_dry boolean) returns void
language sql as $$
  insert into public.keeper_runs (cluster, lines_seen, overdue, marked, failed, tx_signatures, dry_run)
  values (p_cluster, p_lines, p_overdue, p_marked, p_failed, coalesce(p_sigs, '{}'), p_dry)
$$;

revoke all on function
  public.notch_inbox_issued(text, text, timestamptz), public.notch_inbox_state(text, text),
  public.notch_job_update(text, text, text), public.notch_limit_posted(text, text),
  public.notch_attach_tx(text, text, text), public.notch_keeper_run(text, int, int, int, int, text[], boolean)
  from public, anon, authenticated;
grant execute on function
  public.notch_inbox_issued(text, text, timestamptz), public.notch_inbox_state(text, text),
  public.notch_job_update(text, text, text), public.notch_limit_posted(text, text),
  public.notch_attach_tx(text, text, text), public.notch_keeper_run(text, int, int, int, int, text[], boolean)
  to service_role;
