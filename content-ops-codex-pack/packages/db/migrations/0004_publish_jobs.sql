-- 0004_publish_jobs.sql
-- Add publish jobs queue for distribution state machine.

create table if not exists publish_jobs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  post_id uuid not null references posts(id) on delete cascade,
  platform text not null,
  status text not null default 'PENDING',
  idempotency_key text not null,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  scheduled_at timestamptz,
  next_retry_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  started_at timestamptz,
  completed_at timestamptz,
  published_ids jsonb,
  last_error_code text,
  last_error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(post_id, platform),
  unique(idempotency_key),
  constraint publish_jobs_platform_check check (platform in ('instagram', 'tiktok', 'manual_export')),
  constraint publish_jobs_status_check check (
    status in ('PENDING', 'SENDING', 'PUBLISHED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED')
  ),
  constraint publish_jobs_attempt_count_check check (attempt_count >= 0),
  constraint publish_jobs_max_attempts_check check (max_attempts >= 1)
);

create index if not exists publish_jobs_status_idx on publish_jobs(status);
create index if not exists publish_jobs_claimed_at_idx on publish_jobs(claimed_at);
create index if not exists publish_jobs_next_retry_at_idx on publish_jobs(next_retry_at);
create index if not exists publish_jobs_scheduled_at_idx on publish_jobs(scheduled_at);
create index if not exists publish_jobs_post_id_idx on publish_jobs(post_id);
create index if not exists publish_jobs_platform_idx on publish_jobs(platform);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_publish_jobs_updated') then
    create trigger trg_publish_jobs_updated before update on publish_jobs for each row execute procedure set_updated_at();
  end if;
end $$;
