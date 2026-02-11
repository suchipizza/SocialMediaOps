# PRD Task Checklist — Format C + Template Preview

_Last updated: 2026-02-10_

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
- [x] Queue preview resolves template via `post.template_id → job.template_id → pillar.template_id`.
- [x] “Change template” action per job.

### Deletion + Cleanup
- [x] Prevent FK failure by reassigning template references before delete.
- [x] Delete queue preview cache for affected posts when deleting template.
- [x] Delete build cache for template hash when deleting template.
- [x] Add “Clear preview cache” button.

### Renderer Pipeline (Production)
- [ ] Implement full Format C render pipeline in `services/renderer` (load pack → build/cache → Playwright → upload assets → update DB).
- [ ] Implement Format A/B production render pipeline in `services/renderer` (HTML/manifest → Playwright → upload assets).

### Publishing (Distribution)
- [ ] Implement publishing step (use rendered assets to post to Instagram/TikTok or export for manual posting).

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
| Production renderer (Format C) | TBD | Not started | Implement `services/renderer` build/cache/render/upload pipeline. |
| Production renderer (Format A/B) | TBD | Not started | Implement HTML/manifest render pipeline. |
| Security sandboxing | TBD | Not started | Containerize builds and block network egress. |
| Cache TTL | TBD | Not started | Add TTL/cleanup for `.cache/template-builds`. |
| Tests | TBD | Not started | Add detection + preview + render tests. |
