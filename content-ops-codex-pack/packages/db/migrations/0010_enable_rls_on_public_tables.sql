-- 0010_enable_rls_on_public_tables.sql
-- Enable Row Level Security (RLS) on app tables exposed via PostgREST.
--
-- Notes:
-- - This removes anonymous/authenticated direct table access unless policies are added.
-- - Current web/worker flows use service-role server clients, so operational behavior is unchanged.

do $$
declare
  table_name text;
  app_tables text[] := array[
    'projects',
    'pillars',
    'jobs',
    'posts',
    'slides',
    'assets',
    'events_log',
    'publish_jobs',
    'templates',
    'social_accounts',
    'project_social_accounts',
    'worker_control_jobs',
    'worker_heartbeats',
    'worker_leases'
  ];
begin
  foreach table_name in array app_tables loop
    execute format('alter table if exists public.%I enable row level security', table_name);
  end loop;
end $$;

