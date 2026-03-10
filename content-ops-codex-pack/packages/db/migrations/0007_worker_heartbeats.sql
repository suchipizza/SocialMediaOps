-- 0007_worker_heartbeats.sql
-- Worker heartbeat and liveness tracking.

create table if not exists worker_heartbeats (
  worker_id text primary key,
  worker_type text not null,
  status text not null default 'STARTING',
  hostname text,
  pid int,
  last_seen_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_heartbeats_worker_type_check check (
    worker_type in ('SUPERVISOR', 'RENDERER', 'PUBLISHER')
  ),
  constraint worker_heartbeats_status_check check (
    status in ('STARTING', 'IDLE', 'RUNNING', 'DEGRADED', 'STOPPED')
  )
);

create index if not exists worker_heartbeats_type_idx on worker_heartbeats(worker_type);
create index if not exists worker_heartbeats_status_idx on worker_heartbeats(status);
create index if not exists worker_heartbeats_last_seen_idx on worker_heartbeats(last_seen_at);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_worker_heartbeats_updated') then
    create trigger trg_worker_heartbeats_updated before update on worker_heartbeats for each row execute procedure set_updated_at();
  end if;
end $$;
