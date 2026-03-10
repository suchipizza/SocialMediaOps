-- 0008_worker_leases.sql
-- Distributed worker lease table + RPC to enforce singleton workers.

create table if not exists worker_leases (
  lock_key text primary key,
  holder_id text not null,
  lease_expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists worker_leases_lease_expires_idx on worker_leases(lease_expires_at);

-- Atomically claim/renew a lease:
-- - succeeds when lock does not exist
-- - succeeds when caller already owns lock
-- - succeeds when previous lease has expired
create or replace function claim_worker_lease(
  p_lock_key text,
  p_holder_id text,
  p_lease_seconds int default 60,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  acquired boolean,
  holder_id text,
  lease_expires_at timestamptz
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz := v_now + make_interval(secs => greatest(p_lease_seconds, 5));
begin
  if p_lock_key is null or length(trim(p_lock_key)) = 0 then
    raise exception 'claim_worker_lease requires p_lock_key';
  end if;
  if p_holder_id is null or length(trim(p_holder_id)) = 0 then
    raise exception 'claim_worker_lease requires p_holder_id';
  end if;

  insert into worker_leases(lock_key, holder_id, lease_expires_at, metadata)
  values (p_lock_key, p_holder_id, v_expires, coalesce(p_metadata, '{}'::jsonb))
  on conflict (lock_key) do update
    set
      holder_id = excluded.holder_id,
      lease_expires_at = excluded.lease_expires_at,
      metadata = coalesce(excluded.metadata, '{}'::jsonb),
      updated_at = now()
    where
      worker_leases.holder_id = excluded.holder_id
      or worker_leases.lease_expires_at < now()
  returning true, worker_leases.holder_id, worker_leases.lease_expires_at
  into acquired, holder_id, lease_expires_at;

  if found then
    return next;
    return;
  end if;

  return query
  select false, wl.holder_id, wl.lease_expires_at
  from worker_leases wl
  where wl.lock_key = p_lock_key
  limit 1;
end;
$$;

-- Best-effort explicit release.
create or replace function release_worker_lease(
  p_lock_key text,
  p_holder_id text
)
returns boolean
language plpgsql
as $$
declare
  v_released int := 0;
begin
  update worker_leases
  set
    lease_expires_at = now() - interval '1 second',
    updated_at = now()
  where lock_key = p_lock_key
    and holder_id = p_holder_id;

  get diagnostics v_released = row_count;
  return v_released > 0;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_worker_leases_updated') then
    create trigger trg_worker_leases_updated before update on worker_leases for each row execute procedure set_updated_at();
  end if;
end $$;

