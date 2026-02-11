-- 0003_jobs_posts_template_id.sql
-- Add template_id to jobs and posts so template assignment can be per-job.

alter table if exists jobs
  add column if not exists template_id uuid references templates(id) on delete set null;

alter table if exists posts
  add column if not exists template_id uuid references templates(id) on delete set null;

create index if not exists jobs_template_id_idx on jobs(template_id);
create index if not exists posts_template_id_idx on posts(template_id);
