# PRD Task Checklist — Format C + Template Preview

_Last updated: 2026-02-27_

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
- [ ] Implement preview generation for Format B.

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
- [ ] Add worker control queue schema (`worker_control_jobs`) for UI-triggered renderer/publisher runs (no direct process spawn from web).
- [ ] Refactor workers into reusable runners (`runRendererUntilDrained`, `runPublisherOnce`, `runPublisherLoop`) plus thin CLI wrappers.
- [ ] Add Fly worker supervisor process that:
  - polls control queue,
  - runs requested jobs,
  - writes structured run results/logs to DB,
  - keeps renderer/publisher schedule loops active.
- [ ] Add `/operations` UI on web app to:
  - trigger control jobs (`Run renderer now`, `Run publisher now`),
  - show worker heartbeat,
  - show recent run history + error summaries.
- [ ] Add worker heartbeat + liveness model (`worker_heartbeats` table or equivalent) with stale-worker detection.
- [ ] Add idempotency and concurrency guards:
  - one active render worker per queue partition,
  - safe claim/reclaim for stuck jobs,
  - dedupe on control job idempotency keys.
- [ ] Add robust retry/backoff policy config:
  - renderer retries only on transient failures,
  - publisher retry windows + max attempts + dead-letter status.
- [ ] Add structured observability:
  - per-run correlation IDs,
  - logs persisted to DB and emitted to Fly logs,
  - alert thresholds for repeated failures.
- [ ] Add secrets strategy:
  - keep Supabase + platform secrets in Fly secrets/Vercel env,
  - remove reliance on local `.env` for production execution.
- [ ] Add deployment runbook:
  - Fly process model (`web` optional, `worker` required),
  - rollout procedure,
  - rollback and incident checklist.

### Scheduling + Operations Hardening
- [ ] Run publisher continuously on Fly (short poll interval) so scheduled posts publish without manual terminal commands.
- [ ] Keep renderer in drain mode on schedule or control trigger; avoid long idle loops that hide failures.
- [ ] Add explicit "requeue failed publish jobs" bulk action in UI with audit event.
- [ ] Add timezone/schedule validation in UI with explicit UTC preview before saving project/job settings.

### Security / Isolation
- [ ] Build/render Format C in a sandbox or container.
- [ ] Disable network egress during build/render where feasible.
- [ ] Add timeouts and resource limits for builds/renders.

### Testing
- [ ] Tests for template format detection (A/B/C).
- [ ] Preview generation success/failure tests.
- [ ] Format C render pipeline smoke test.

---

## Owner / Status / Next Action

| Area | Owner | Status | Next action |
|---|---|---|---|
| Format B preview | TBD | Not started | Implement preview generator for background‑image packs and manifest text boxes. |
| Format C preview manifest requirement | TBD | Partially done | Enforce `manifest.json` presence for Format C (remove default manifest fallback). |
| Production renderer (Format C) | TBD | Done | Monitor worker schedule + retries. |
| Production renderer (Format A/B) | TBD | Not started | Implement HTML/manifest render pipeline. |
| Publishing queue + status machine | TBD | Done | Implement platform adapters + credentials plumbing. |
| Instagram publishing adapter | TBD | Done | Configure real IG credentials and run with `PUBLISH_DRY_RUN=false`. |
| TikTok/manual export publishing | TBD | Not started | Implement adapters and credentials flow. |
| Security sandboxing | TBD | Not started | Containerize builds and block network egress. |
| Cache TTL | TBD | Not started | Add TTL/cleanup for `.cache/template-builds`. |
| Tests | TBD | Not started | Add detection + preview + render tests. |
| Deployment architecture (Vercel + Fly) | TBD | Proposed | Add worker control queue + Fly supervisor + `/operations` UI control panel. |
| Worker observability and heartbeat | TBD | Not started | Add heartbeats, run history, and stale-worker alerts. |
| Scheduling reliability (always-on publisher) | TBD | Not started | Run publisher continuously on Fly with retry/backoff monitoring. |
