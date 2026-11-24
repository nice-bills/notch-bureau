-- Hourly keeper: pg_cron calls the `keeper` Edge Function through pg_net.
--
-- Nothing secret is in this file. The project URL and a shared secret are read from Supabase Vault at run time;
-- supabase/README.md has the two one-line statements that put them there. The fee-payer key lives in the Edge
-- Function's own secrets (`supabase secrets set`), never in the database.
--
-- Skipped quietly when pg_cron / pg_net are not available (a plain Postgres, the local pglite test).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
end $$;

create or replace function private.run_keeper() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  secret text;
  req bigint;
begin
  select decrypted_secret into base   from vault.decrypted_secrets where name = 'notch_project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'notch_keeper_secret';
  if base is null or secret is null then
    raise warning 'notch keeper: add the Vault secrets notch_project_url and notch_keeper_secret (see supabase/README.md)';
    return null;
  end if;
  select net.http_post(
    url := rtrim(base, '/') || '/functions/v1/keeper',
    headers := jsonb_build_object('content-type', 'application/json', 'x-keeper-secret', secret),
    body := '{"send": true}'::jsonb,
    timeout_milliseconds := 55000) into req;
  return req;
end $$;
revoke all on function private.run_keeper() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('notch-keeper-hourly', '0 * * * *', 'select private.run_keeper()');
  end if;
end $$;
