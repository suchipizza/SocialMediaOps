-- 0005_social_accounts.sql
-- Reusable social accounts and project linking.

create table if not exists social_accounts (
  id uuid primary key default uuid_generate_v4(),
  platform text not null,
  name text not null,
  credentials_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform, name),
  constraint social_accounts_platform_check check (platform in ('instagram', 'tiktok'))
);

create table if not exists project_social_accounts (
  project_id uuid not null references projects(id) on delete cascade,
  account_id uuid not null references social_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, account_id)
);

create index if not exists project_social_accounts_project_id_idx on project_social_accounts(project_id);
create index if not exists project_social_accounts_account_id_idx on project_social_accounts(account_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_social_accounts_updated') then
    create trigger trg_social_accounts_updated before update on social_accounts for each row execute procedure set_updated_at();
  end if;
end $$;
