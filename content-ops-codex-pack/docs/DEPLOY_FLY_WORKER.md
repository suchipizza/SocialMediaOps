# Deploy Always-On Supervisor on Fly

This deploys `services/workers/src/control-supervisor.js` as a long-running worker so renderer/publisher are controlled via `worker_control_jobs` (DB queue), not terminal commands.

## 1) Prerequisites

- Migrations applied:
  - `packages/db/migrations/0006_worker_control_jobs.sql`
  - `packages/db/migrations/0007_worker_heartbeats.sql`
  - `packages/db/migrations/0008_worker_leases.sql`
- Web app deployed (Vercel or equivalent) with access to same Supabase project.
- Fly CLI installed and authenticated.

## 2) Deploy Worker App (Fly)

From repo root:

```bash
fly launch --no-deploy --copy-config --config fly.worker.toml
fly deploy --config fly.worker.toml
```

Set required secrets:

```bash
fly secrets set \
  SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  SUPABASE_STORAGE_BUCKET=content-ops \
  PUBLISH_DRY_RUN=false \
  IG_GRAPH_API_VERSION=v21.0
```

Optional worker tuning:

```bash
fly secrets set \
  WORKER_CONTROL_POLL_MS=5000 \
  WORKER_CONTROL_JOB_KEEPALIVE_MS=30000 \
  WORKER_CONTROL_JOB_KEEPALIVE_FAILURE_THRESHOLD=3 \
  WORKER_PUBLISHER_LOOP_ENABLED=true \
  PUBLISH_LOOP_POLL_MS=15000 \
  WORKER_SUPERVISOR_LEASE_SECONDS=600 \
  WORKER_HEARTBEAT_RETENTION_DAYS=7 \
  RENDER_BATCH_SIZE=1 \
  RENDER_POST_TIMEOUT_MS=180000 \
  RENDER_SLIDE_READY_TIMEOUT_MS=20000 \
  RENDER_NETWORK_IDLE_TIMEOUT_MS=3000 \
  RENDER_SLIDE_SETTLE_DELAY_MS=80
```

Renderer runtime policy:
- Format C rendering now requires a prebuilt template pack containing `dist/` or `build/`.
- Worker runtime does not run `npm install` or `npm run build` during render jobs.
- Keep `RENDER_BATCH_SIZE=1` in production until memory headroom is confirmed.
- For legacy templates uploaded before this change, re-upload template zips once so the app can generate and store prebuilt render bundles.

If you render full carousels on Fly, set VM memory to at least 2 GB:

```bash
fly scale memory 2048 -a content-ops-worker
```

## 3) Force Queue-Only Triggering in Production (Web)

Set these env vars in web production (Vercel):

```bash
ENABLE_UI_WORKER_TRIGGER=true
ENABLE_WORKER_CONTROL_QUEUE=true
UI_WORKER_TRIGGER_MODE=queue
UI_WORKER_TRIGGER_SPAWN_FALLBACK=false
APP_ENV=production
```

Behavior:
- UI actions enqueue control jobs in DB.
- Web never attempts local process spawn in production runtime.

## 4) Verify

1. Open `/operations`:
   - heartbeat should show one active `SUPERVISOR`.
   - no stale warning during steady state.
2. Click:
   - `Run renderer now`
   - `Run publisher now`
3. Confirm control jobs transition:
   - `PENDING -> CLAIMED/RUNNING -> SUCCEEDED`
4. Approve a post in `/queue`:
   - should enqueue control jobs
   - renderer should produce assets
   - publisher should claim due publish jobs

## 5) Rollback

- Set web env `ENABLE_UI_WORKER_TRIGGER=false` to stop new triggers.
- `fly scale count 0 --config fly.worker.toml` to stop worker.
- Existing DB queue state is preserved for replay/retry.
