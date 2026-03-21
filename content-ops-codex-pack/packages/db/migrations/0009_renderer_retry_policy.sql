-- 0009_renderer_retry_policy.sql
-- Renderer retry/backoff metadata on posts.

alter table if exists posts
  add column if not exists render_attempt_count int not null default 0,
  add column if not exists render_max_attempts int not null default 3,
  add column if not exists render_next_retry_at timestamptz,
  add column if not exists render_last_attempt_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'posts_render_attempt_count_check'
  ) then
    alter table posts
      add constraint posts_render_attempt_count_check check (render_attempt_count >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'posts_render_max_attempts_check'
  ) then
    alter table posts
      add constraint posts_render_max_attempts_check check (render_max_attempts >= 1);
  end if;
end $$;

create index if not exists posts_render_retry_ready_idx
  on posts(status, render_next_retry_at, created_at)
  where status = 'APPROVED';
