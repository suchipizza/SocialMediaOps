-- 0006_worker_control_jobs.sql
-- Control queue for UI-triggered worker actions (renderer/publisher).

create table if not exists worker_control_jobs (
  id uuid primary key default uuid_generate_v4(),
  type text not null,
  status text not null default 'PENDING',
  priority int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  scope_key text,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  scheduled_at timestamptz,
  next_retry_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  started_at timestamptz,
  completed_at timestamptz,
  result_json jsonb,
  error_code text,
  error_message text,
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(idempotency_key),
  constraint worker_control_jobs_type_check check (
    type in (
      'RUN_RENDERER_DRAIN',
      'RUN_PUBLISHER_ONCE',
      'RUN_PUBLISHER_LOOP_START',
      'RUN_PUBLISHER_LOOP_STOP'
    )
  ),
  constraint worker_control_jobs_status_check check (
    status in (
      'PENDING',
      'CLAIMED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
      'CANCELLED'
    )
  ),
  constraint worker_control_jobs_attempt_count_check check (attempt_count >= 0),
  constraint worker_control_jobs_max_attempts_check check (max_attempts >= 1)
);

create index if not exists worker_control_jobs_status_idx on worker_control_jobs(status);
create index if not exists worker_control_jobs_type_idx on worker_control_jobs(type);
create index if not exists worker_control_jobs_scheduled_at_idx on worker_control_jobs(scheduled_at);
create index if not exists worker_control_jobs_next_retry_at_idx on worker_control_jobs(next_retry_at);
create index if not exists worker_control_jobs_claimed_at_idx on worker_control_jobs(claimed_at);
create index if not exists worker_control_jobs_created_at_idx on worker_control_jobs(created_at desc);
create index if not exists worker_control_jobs_claim_ready_idx
  on worker_control_jobs(status, scheduled_at, next_retry_at, priority desc, created_at);

-- Prevent duplicate active control jobs for the same worker action scope.
create unique index if not exists worker_control_jobs_active_scope_idx
  on worker_control_jobs(type, scope_key)
  where scope_key is not null
    and status in ('PENDING', 'CLAIMED', 'RUNNING', 'FAILED_RETRYABLE');

-- Atomic claim function for worker supervisors.
create or replace function claim_worker_control_jobs(
  p_worker_id text,
  p_limit int default 1,
  p_claim_stale_seconds int default 600
)
returns setof worker_control_jobs
language plpgsql
as $$
begin
  return query
  with eligible as (
    select wcj.id
    from worker_control_jobs wcj
    where (
      wcj.status in ('PENDING', 'FAILED_RETRYABLE')
      and (wcj.scheduled_at is null or wcj.scheduled_at <= now())
      and (wcj.next_retry_at is null or wcj.next_retry_at <= now())
    ) or (
      wcj.status in ('CLAIMED', 'RUNNING')
      and wcj.claimed_at is not null
      and wcj.claimed_at <= (now() - make_interval(secs => greatest(p_claim_stale_seconds, 1)))
    )
    order by wcj.priority desc, coalesce(wcj.scheduled_at, wcj.created_at) asc, wcj.created_at asc
    limit greatest(p_limit, 1)
    for update skip locked
  ),
  claimed as (
    update worker_control_jobs wcj
    set
      status = 'CLAIMED',
      claimed_at = now(),
      claimed_by = p_worker_id,
      started_at = null,
      completed_at = null,
      updated_at = now()
    where wcj.id in (select id from eligible)
    returning wcj.*
  )
  select * from claimed;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_worker_control_jobs_updated') then
    create trigger trg_worker_control_jobs_updated before update on worker_control_jobs for each row execute procedure set_updated_at();
  end if;
end $$;
