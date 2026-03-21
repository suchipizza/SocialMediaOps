# PRD Task Checklist — Format C + Template Preview

_Last updated: 2026-03-10_

## Checklist

### Docs
- [x] Update PRD to include Format C + preview requirements.

### Database
- [x] Add template preview fields (`format`, `status`, `template_hash`, `preview_assets`, `preview_error`, `preview_generated_at`).
- [x] Add per‑job/per‑post `template_id` (and indexes).

### Template Upload + Validation
- [x] Detect template format A/B/C on upload from zip contents.
- [x] Validate `manifest.json` schema (including `react-vite-v1`).
- [x] Persist `template.format` and `template_hash`.
- [x] Mark `INVALID_RENDER` on preview failures and block use.
- [ ] Require `manifest.json` for Format C (currently a default is used when missing).

### Preview Generation (Required)
- [x] Generate preview assets after upload for Format A/C using fixed placeholder payloads.
- [x] Store preview URLs in `templates.preview_assets`.
- [x] Surface preview errors in UI and block assignment.
- [x] Cache preview by template hash.
- [x] Implement preview generation for Format B.

### Format C Build + Render (Preview)
- [x] Unzip and build Vite template per `template_hash`.
- [x] Cache build artifacts in `.cache/template-builds/<hash>`.
- [x] Render slides with Playwright using querystring payloads.

### Queue / Job / Post Integration
- [x] Assign template at job creation (UI selection + persistence).
- [x] Posts inherit job’s `template_id`.
- [x] Posts inherit `publish_platforms` from project platform settings.
- [x] Queue preview resolves template via `post.template_id → job.template_id → pillar.template_id`.
- [x] “Change template” action per job.

### Deletion + Cleanup
- [x] Prevent FK failure by reassigning template references before delete.
- [x] Delete queue preview cache for affected posts when deleting template.
- [x] Delete build cache for template hash when deleting template.
- [x] Add “Clear preview cache” button.

### Renderer Pipeline (Production)
- [x] Implement full Format C render pipeline in `services/renderer` (load pack → build/cache → Playwright → upload assets → update DB).
- [ ] Implement Format A/B production render pipeline in `services/renderer` (HTML/manifest → Playwright → upload assets).

### Publishing (Distribution)
- [x] Add `publish_jobs` queue schema (idempotency key, retries, claiming, scheduling).
- [x] Implement publisher worker status machine (`PENDING/FAILED_RETRYABLE -> SENDING -> PUBLISHED/FAILED_*`).
- [x] Implement Instagram publishing adapter (Graph API carousel publish, retry-aware errors).
- [x] Add account settings UI and project-account linking for per-project credentials.
- [ ] Implement publishing step (use rendered assets to post to TikTok or export for manual posting).

### Deployment Architecture Proposal (Vercel + Fly + Supabase)
- [x] Add worker control queue schema (`worker_control_jobs`) for UI-triggered renderer/publisher runs (no direct process spawn from web).
- [x] Refactor workers into reusable runners (`runRendererUntilDrained`, `runPublisherOnce`, `runPublisherLoop`) plus thin CLI wrappers.
- [x] Add worker supervisor process (`services/workers/src/control-supervisor.js`) that:
  - polls control queue,
  - runs requested jobs,
  - writes run results to DB (`worker_control_jobs.result_json` + `events_log`),
  - keeps renderer/publisher schedule loops active.
- [x] Add `/operations` UI on web app to:
  - [x] trigger control jobs (`Run renderer now`, `Run publisher now`),
  - [x] show worker heartbeat,
  - [x] show recent run history + error summaries.
- [x] Add worker heartbeat + liveness model (`worker_heartbeats` table or equivalent) with stale-worker detection.
- [ ] Add idempotency and concurrency guards:
  - [x] one active render worker per queue partition,
  - [x] safe claim/reclaim for stuck jobs (`claim_worker_control_jobs`, publish stale-claim handling),
  - [x] dedupe on control job idempotency keys / active scope guard.
- [ ] Add robust retry/backoff policy config:
  - [x] renderer retries only on transient failures,
  - [x] publisher retry windows + max attempts + dead-letter status (`FAILED_FINAL`).
- [ ] Add structured observability:
  - [x] per-run correlation IDs,
  - [x] run status/result persisted to DB (`worker_control_jobs`, `events_log`) and stdout logs available for worker runtime,
  - [x] alert thresholds for repeated failures.
- [ ] Add secrets strategy:
  - keep Supabase + platform secrets in Fly secrets/Vercel env,
  - remove reliance on local `.env` for production execution.
- [ ] Add deployment runbook:
  - Fly process model (`web` optional, `worker` required),
  - rollout procedure,
  - rollback and incident checklist.

### Scheduling + Operations Hardening
- [ ] Run publisher continuously on Fly (short poll interval) so scheduled posts publish without manual terminal commands.
- [x] Keep renderer in drain mode on control trigger (no long-running renderer loop).
- [x] Add explicit "requeue failed publish jobs" bulk action in UI with audit event.
- [x] Add timezone/schedule validation in UI with explicit UTC preview before saving project/job settings.

### Security / Isolation
- [ ] Build/render Format C in a sandbox or container.
- [ ] Disable network egress during build/render where feasible.
- [ ] Add timeouts and resource limits for builds/renders.

### Testing
- [ ] Tests for template format detection (A/B/C).
- [ ] Preview generation success/failure tests.
- [ ] Format C render pipeline smoke test.

---

## Sprint-Ready Plan (Owner / Status / ETA)

| Sprint | Workstream | Owner | Status | ETA | Next action |
|---|---|---|---|---|---|
| Sprint 1 (2026-03-11 → 2026-03-21) | Enforce strict Format C contract (`manifest.json` required; remove fallback default) | Web + Templates | Planned | 2026-03-14 | Update upload validation in `apps/web/lib/templates.ts`, add migration note, and fail fast with clear UI error. |
| Sprint 1 (2026-03-11 → 2026-03-21) | Queue/publish reliability hardening (UTC schedule preview in UI + bulk requeue failed publish jobs) | Web | Planned | 2026-03-18 | Add UTC preview component in Projects/Jobs forms and add bulk action on `/queue` with audit log event. |
| Sprint 1 (2026-03-11 → 2026-03-21) | Remove ambiguous local trigger path in production mode | Web + Workers | In progress | 2026-03-18 | Keep control-queue path as default for prod, gate spawn fallback to local/dev only. |
| Sprint 2 (2026-03-24 → 2026-04-04) | Format A/B production render pipeline | Renderer + Workers | Planned | 2026-04-01 | Implement renderer adapters for A/B and wire through `renderer-runner` with status/error parity to Format C. |
| Sprint 2 (2026-03-24 → 2026-04-04) | Publishing adapters completion (TikTok + manual export flow) | Workers + Web | Planned | 2026-04-04 | Implement TikTok adapter and expose manual-export output retrieval in UI/storage. |
| Sprint 2 (2026-03-24 → 2026-04-04) | Retry/backoff parity for renderer jobs | Workers | Planned | 2026-04-04 | Add transient/final render error classification and retry windows like publisher path. |
| Sprint 3 (2026-04-07 → 2026-04-18) | Fly production rollout (always-on supervisor + publisher loop) | Ops | Planned | 2026-04-11 | Deploy worker service on Fly, set loop poll intervals, and validate scheduled posting with no local terminal dependency. |
| Sprint 3 (2026-04-07 → 2026-04-18) | Observability + incident readiness | Ops + Workers | Planned | 2026-04-15 | Add correlation IDs, failure threshold alerts, and deployment/rollback runbook. |
| Sprint 3 (2026-04-07 → 2026-04-18) | Security isolation for build/render | Platform | Planned | 2026-04-18 | Run template build/render in container sandbox, restrict egress, and set CPU/memory/time limits. |
| Sprint 3 (2026-04-07 → 2026-04-18) | Automated tests baseline | QA + Eng | Planned | 2026-04-18 | Add tests for format detection, preview success/failure, and Format C render smoke path. |

## Current Status Summary

| Area | Owner | Status | ETA |
|---|---|---|---|
| Format B preview | Web + Templates | Done | 2026-03-10 |
| Worker control queue + supervisor + `/operations` heartbeat/history | Workers + Web | Done (code complete) | 2026-03-10 |
| Format C production renderer | Renderer + Workers | Done | 2026-03-10 |
| Format A/B production renderer | Renderer + Workers | Not started | Sprint 2 |
| TikTok/manual export distribution | Workers + Web | Partial (manual stub, TikTok not implemented) | Sprint 2 |
| Scheduling reliability on always-on infra | Ops + Workers | In progress | Sprint 3 |
| Security sandboxing | Platform | Not started | Sprint 3 |
| Automated tests | QA + Eng | Not started | Sprint 3 |
