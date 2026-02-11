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

