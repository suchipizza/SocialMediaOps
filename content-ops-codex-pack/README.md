# Content Ops — Codex Pack Scaffold

This scaffold is designed to be pasted into a repo and completed with Codex. It includes:
- Web app (Next.js) routes & UI skeleton for Projects/Templates/Queue/Jobs
- DB migrations (Postgres) for core tables
- Worker modules (renderer + publisher + scheduler)
- Manifest validator
- Renderer service (Playwright) to produce slide images

## Quickstart (suggested)
1. Create a Next.js app in `apps/web` (or keep this layout and run from root with Turbo).
2. Provision Postgres (Supabase or self-hosted).
3. Run migrations from `packages/db/migrations`.
4. Configure env vars in `.env.example`.
5. Start workers in `services/workers`.

> Notes:
- This is a scaffold: functions contain TODOs and clear interfaces.
- Storage: use S3/R2/Supabase Storage with stable public URLs for IG publishing.

## Renderer (Format C)
To render approved posts with Format C templates:
- Ensure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` are set.
- Run the worker: `npm run renderer -w content-ops-workers`

## Publisher Queue (Step 1 Foundation)
Publishing now uses `publish_jobs` with a status machine (`PENDING`, `SENDING`, `PUBLISHED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELLED`).
- Apply migration `packages/db/migrations/0004_publish_jobs.sql`.
- Apply migration `packages/db/migrations/0005_social_accounts.sql` for reusable account settings + project linking.
- Renderer enqueue happens after successful render (`RENDER_SUCCESS`).
- Run publisher worker: `npm run publisher -w content-ops-workers`
- Default mode is dry-run (`PUBLISH_DRY_RUN=true`) so you can validate transitions safely.
- To enable real Instagram publish, set `PUBLISH_DRY_RUN=false` and configure credentials:
- Env fallback: `IG_ACCESS_TOKEN`, `IG_USER_ID`
- Or link project accounts from `/projects` account settings UI (preferred).
- Or per-project `projects.ig_account_config` JSON (stored in `bytea`) with one of:
  - `ig_access_token` + `ig_user_id`
  - `access_token` + `user_id`
