-- Pin search_path on the service-role write functions (Supabase security advisor: function_search_path_mutable).
-- Their tables live in public; pg_temp last so a temp object can never shadow them.
alter function public.notch_inbox_state(text, text) set search_path = public, pg_temp;
alter function public.notch_inbox_issued(text, text, timestamptz) set search_path = public, pg_temp;
alter function public.notch_job_update(text, text, text) set search_path = public, pg_temp;
alter function public.notch_limit_posted(text, text) set search_path = public, pg_temp;
alter function public.notch_attach_tx(text, text, text) set search_path = public, pg_temp;
alter function public.notch_keeper_run(text, integer, integer, integer, integer, text[], boolean) set search_path = public, pg_temp;
