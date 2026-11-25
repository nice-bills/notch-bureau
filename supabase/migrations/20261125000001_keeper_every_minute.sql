-- Final gate #3/#7: the keeper runs EVERY MINUTE (it was hourly). A loan can be marked defaulted from due + 1 second, and the only
-- way a lender can still leave at the pre-loss price is to claim in the gap before the mark, so the gap is the keeper's cadence.
-- The function sorts overdue lines most-overdue first, sends up to 40 per run and stops at a 45 s budget, so runs do not overlap.
-- Skipped quietly when pg_cron is not available (a plain Postgres, the local pglite test).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('notch-keeper-hourly') where exists (select 1 from cron.job where jobname = 'notch-keeper-hourly');
    perform cron.schedule('notch-keeper-every-minute', '* * * * *', 'select private.run_keeper()');
  end if;
end $$;
