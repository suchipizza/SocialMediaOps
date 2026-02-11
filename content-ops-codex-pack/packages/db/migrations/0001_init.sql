-- 0001_init.sql
-- Core schema for Content Ops (Postgres)

create extension if not exists "uuid-ossp";

-- Projects
create table if not exists projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  timezone text not null default 'Europe/Zurich',
  platforms_enabled jsonb not null default '{"instagram": true, "tiktok": false}'::jsonb,
  slot_times jsonb not null default '["09:00","13:00","18:00"]'::jsonb,
  ig_account_config bytea,  -- encrypted blob (implementation-specific)
  tiktok_account_config bytea, -- encrypted blob
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Templates
create table if not exists templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  platform_scope text not null default 'both', -- instagram|tiktok|both
  template_pack_url text not null,
  manifest_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pillars
create table if not exists pillars (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  template_id uuid not null references templates(id),
  default_hashtags text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, name)
);

-- Jobs
create table if not exists jobs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  status text not null default 'RUNNING', -- RUNNING|PAUSED|STOPPED|COMPLETED|COMPLETED_NO_CONTENT|FAILED
  start_date date not null,
  target_post_count int not null default 21,
  ingest_source text not null default 'csv', -- csv|sheets|manual|ai
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Posts
create table if not exists posts (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  pillar_id uuid not null references pillars(id),
  status text not null default 'DRAFT', -- see PRD
  ordering_index int not null default 0,
  slide_count int not null default 10,
  caption text,
  hashtags text[] default '{}',
  publish_platforms jsonb not null default '{"instagram": true, "tiktok": false}'::jsonb,
  scheduled_at timestamptz,
  published_ids jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Slides
create table if not exists slides (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references posts(id) on delete cascade,
  slide_index int not null,
  fields jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(post_id, slide_index)
);

-- Assets
create table if not exists assets (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references posts(id) on delete cascade,
  slide_index int not null,
  image_url text not null,
  width int not null,
  height int not null,
  bytes int not null,
  mime text not null,
  created_at timestamptz not null default now(),
  unique(post_id, slide_index)
);

-- Events log
create table if not exists events_log (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  post_id uuid references posts(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Updated_at triggers (optional)
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_projects_updated') then
    create trigger trg_projects_updated before update on projects for each row execute procedure set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_templates_updated') then
    create trigger trg_templates_updated before update on templates for each row execute procedure set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_pillars_updated') then
    create trigger trg_pillars_updated before update on pillars for each row execute procedure set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_jobs_updated') then
    create trigger trg_jobs_updated before update on jobs for each row execute procedure set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_posts_updated') then
    create trigger trg_posts_updated before update on posts for each row execute procedure set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_slides_updated') then
    create trigger trg_slides_updated before update on slides for each row execute procedure set_updated_at();
  end if;
end $$;
