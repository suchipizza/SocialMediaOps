# PRD — Content Ops Web App (Approval-First, Carousel Renderer, Direct IG + TikTok Publishing)

> Version: 1.0  
> Date: 2026-02-02  
> Owner: Product / Engineering  
> Target: Codex implementation handoff

---

## 1) Overview

### Problem
Creators need a reliable, approval-first workflow to generate, review, render, schedule, and directly publish carousel-style posts to Instagram and TikTok at a cadence of 3 posts/day, while keeping templates consistent across content pillars.

### Solution
A web app that:
1) accepts post scripts (AI-generated or manual),
2) routes them through an approval queue,
3) renders them into carousel images using a template pack (no Figma integration required),
4) schedules posts into 3 daily slots,
5) publishes directly to Instagram and TikTok with captions + hashtags,
6) logs results and errors.

### Key constraints
- **Approval-first**: queue with statuses; weekly batch approvals.
- **No Figma integration required**: user provides a template pack exported once and uploaded.
- **Direct posting**:
  - **Instagram**: Graph API content publishing flow (create media containers → carousel container → publish).
  - **TikTok**: Content Posting API supports photo posts (requires scopes/permissions).
- **Format correctness**:
  - Instagram: image aspect ratio must be within **4:5 to 1.91:1** and JPEG ≤ 8MB.
- **Rendering**: Full custom renderer (HTML/CSS → images via Playwright).

### Target users
Solo creators and small teams who need predictable weekly approvals and automated publishing.

---

## 2) Goals & Success Criteria

### Goals
- Create/manage projects with multiple pillars and templates.
- Ingest scripts via AI generation, manual entry, and batch import (CSV or Google Sheets link).
- Weekly approval workflow: approve/reject/edit posts before publishing.
- Automatic scheduling: 3 daily time slots in a chosen timezone (default Europe/Zurich).
- Render carousels from scripts + templates with predictable typography/layout.
- Publish directly to Instagram and TikTok with caption + hashtags.
- Provide reliable logging, retries, and failure visibility.

### Success criteria (MVP)
- 21 approved posts can be scheduled and published over 7 days (3/day) without intervention besides approvals.
- <1% publishing failures due to preventable formatting issues (aspect ratio/size).
- Rendering succeeds for ≥95% of approved posts without manual resizing.

---

## 3) Non-goals (MVP)
- Importing raw Figma files (.fig) or direct Figma API integration.
- Advanced analytics beyond post IDs/URLs and basic publish outcomes.
- Complex multi-user roles (MVP: single owner/admin).

---

## 4) Core Concepts & Definitions

### Project
A container for connected social accounts (IG/TikTok), content pillars, templates, posting slots, and jobs.

### Pillar
A named content category (typically 8). Each pillar maps to exactly one template (MVP).

### Template Pack (no Figma integration)
The app does **not** parse `.fig` files. Users upload a **Template Pack** as a `.zip` in one of three supported formats:

**Format A (recommended): HTML Template Pack**
- `template.html`
- `styles.css`
- optional `script.js` (small layout helpers)
- `/assets/*` (images/icons/fonts if licensed)
- `manifest.json` (declares placeholders, slide count, output size, fit rules)

**Format B: Exported background images + manifest**
- `/backgrounds/slide_01.png ... slide_N.png` (exported once from Figma)
- `manifest.json` declares text boxes per slide (x/y/w/h, font, fit rules)
- Renderer composites background + text via HTML/CSS.

**Format C: React/Vite Template Pack (code-based templates)**
- A `.zip` containing a Vite + React project that renders a single slide deterministically from query parameters.
- Required:
  - `package.json`
  - `vite.config.ts` (or `vite.config.js`)
  - `index.html`
  - `src/main.tsx`
  - `src/App.tsx`
  - optional `src/index.css` and component files
  - `manifest.json` (Format C manifest; see below)
- Rendering contract:
  - Template must support: `GET /?slide=<1..N>&data=<base64url(JSON)>`
  - Template must render exactly one slide at the manifest output size per request.
- Security: Format C packs execute arbitrary JS. Renderer MUST build+render in an isolated environment (container/sandbox) with network egress disabled where feasible.

### Post Script
Structured post content:
- pillar
- slide texts (slide 1..N)
- caption
- hashtags list
- optional metadata (language, tone, CTA type)

### Job
A batch (default 21 posts/week) that ingests scripts, creates drafts, queues for approval, schedules, publishes, and ends when all approved posts are published (or no approved posts remain).

---

## 5) User Stories

### Template management
- Upload template pack zip, name it, preview it, delete it.
- Create multiple templates and assign to pillars.

### Project management
- Create/edit/delete project.
- Connect IG and/or TikTok accounts (OAuth/token setup).
- Set timezone and 3 daily slots.

### Pillars
- Create/edit/delete pillars.
- Assign a template to each pillar.

### Post creation
- Manual entry (slides/caption/hashtags + pillar).
- AI generation (pillar + format → slides/caption/hashtags).
- Import batch from CSV or Google Sheets link.

### Approval workflow
- Review drafts; approve/reject; inline edits.
- Re-render preview after edits.
- Optional AI help to shorten text to fit.

### Scheduling & publishing
- Define job start date.
- Pause/resume/stop job.
- Unapproved posts are skipped; next approved fills slot.

---

## 6) Functional Requirements

### 6.1 Authentication & Accounts
- MVP auth: email/password.
- Store platform tokens encrypted at rest.

### 6.2 Templates
**Create**
- Upload `.zip` template pack
- Fields: name, platform scope (IG/TikTok/both), default output format (e.g., 1080×1350)
- Validate `manifest.json` schema.
 - Detect template format:
   - Format A: contains `template.html` + `manifest.json`
   - Format B: contains `/backgrounds/` + `manifest.json`
   - Format C: contains `package.json` + `vite.config.*` + `src/App.tsx` + `manifest.json`

**Manage**
- List/rename/delete templates.
- Deleting template blocked if referenced by active pillars/jobs unless user reassigns.

**Placeholders**
- Minimum placeholders per slide: `headline`, `body`, `footer`, `page_number`.

**Template Upload Preview (MVP requirement)**
- After upload and manifest validation, Content Ops MUST generate a preview carousel with placeholder text and display it in the UI.
- Preview output:
  - Render and show slide thumbnails (1..N) in a “Template Preview” page.
  - Use a fixed placeholder payload:
    - `headline`: "SAMPLE HEADLINE"
    - `body`: "Sample body text to test wrapping and fit. Keep this text long enough to force fitting."
    - `footer`: "us.v2"
    - `page_number`: "1/N"
    - For the last slide, include a CTA placeholder: "Sample CTA text. Link in bio."
- Preview should be generated per template version (hash) and cached.
- If preview render fails:
  - Template status becomes `INVALID_RENDER`
  - UI shows actionable error logs and blocks assignment to pillars.

### 6.3 Projects
**Create**
- name, description, timezone (default Europe/Zurich)
- platforms enabled: IG and/or TikTok
- connect social accounts (store tokens)
- define 3 daily slot times

**Delete**
- Deletes non-published drafts/jobs; retains published logs unless confirmed hard delete.

### 6.4 Pillars
- CRUD pillars: name, template_id, optional default hashtag set.
- Enforce: each pillar has exactly one template (MVP).

### 6.5 Scheduling
- Define exactly 3 posting slots per day: slot_1, slot_2, slot_3.
- Validate uniqueness and timezone handling.

### 6.6 Posts & Jobs

#### Job creation
- Default 21 posts; user may change.

#### Ingest methods
1) CSV upload (preferred)
2) Google Sheets link (optional; treat as CSV export)
3) Manual entry
4) AI generation

#### CSV/Sheet structure
Required columns:
- `pillar`
- `slide_1` ... `slide_N`
- `caption`
- `hashtags` (comma- or space-separated)

Rules:
- Number of rows defines number of posts created.
- Invalid pillar rows flagged `NEEDS_FIX`.

#### Post states
- `DRAFT`
- `READY_FOR_REVIEW`
- `APPROVED`
- `REJECTED`
- `RENDERED`
- `SCHEDULED`
- `PUBLISHING`
- `PUBLISHED`
- `FAILED`

#### Approval behavior
- Only `APPROVED` posts can be scheduled/published.
- Rejected posts skipped for the job unless reopened.

#### Skip logic (“keep cadence”)
At each slot time:
- Publish the next eligible `APPROVED + RENDERED` post in job order.
- If none available: do nothing for that slot.

#### Job control
- Job states: `RUNNING`, `PAUSED`, `STOPPED`, `COMPLETED`, `COMPLETED_NO_CONTENT`, `FAILED`.

---

## 7) Rendering Requirements (Playwright)

### Output formats
- Instagram feed carousel (default): **1080×1350 (4:5)** JPEG, ≤ 8MB per slide.
- TikTok photo post: configurable (commonly 1080×1920 or 1080×1350).

### Rendering pipeline
1) Take approved post + template pack
2) Substitute placeholders into HTML
3) Render each slide via Playwright
4) Export images to storage; store stable URLs
5) Attach assets to post

### Format C rendering pipeline (Playwright + Vite)
1) Unzip template pack to an isolated sandbox directory
2) Run `npm ci` and `npm run build` once per template hash; cache the build artifact (`dist/`)
3) For each slide `i`:
   - Create JSON payload `{ output, post }`, base64url-encode it
   - Load `dist/index.html?slide=i&data=<...>` in Playwright
   - Set viewport to `{ width, height }` per manifest output
   - Screenshot to image buffer
4) Upload images, store in `assets`, mark post `RENDERED`

### Format C manifest (minimum)
`manifest.json` must include:
- `template_format`: `"react-vite-v1"`
- `template_version`: string
- `output`: `{ width, height, format, quality }`
- `slide_count`: integer
- `render`: `{ mode: "querystring", query: { slide: "slide", data: "data" } }`

### Text fitting rules
Per placeholder: `fit_mode` one of:
- `SHRINK_TO_FIT` (down to min font px)
- `TRUNCATE` (ellipsis)
- `WRAP` (max lines)
- `OVERFLOW_ERROR` (fail render)

Default: `SHRINK_TO_FIT` → fallback `TRUNCATE`.

### Preview
- Thumbnails + full-size viewer
- “Re-render” after edits.

### “Use AI to correct”
AI edits copy to fit constraints:
- shorten text, rewrite hook, reduce to N chars
Not allowed: arbitrary movement of layout elements beyond template-defined boxes.

---

## 8) Publishing Integrations

### 8.1 Instagram
- Carousel publishing:
  1) Create child media containers (each slide)
  2) Create carousel container referencing children
  3) Publish carousel container
- Validate:
  - JPEG
  - ≤ 8MB
  - aspect ratio within [4:5, 1.91:1]

### 8.2 TikTok
- Photo post publishing via Content Posting API (feature-flagged in MVP).
- Store publish IDs and status.

### Tokens & permissions
- Store encrypted; handle token refresh where possible.
- Mark “Needs Reconnect” on auth failures.

### Rate limiting
- Exponential backoff on 429/5xx.
- Use idempotency keys per publish attempt to prevent duplicates.

---

## 9) UI/UX Requirements

### Templates
- Upload, validate, preview, list, delete.

### Project Setup
- Name/description; platforms; connect accounts; timezone; slot times; pillars.

### Queue
- Filters by status/pillar/job.
- Bulk approve/reject.
- Inline edits + preview + re-render.
- AI assist actions (shorten, rewrite hook, reduce chars).

### Jobs
- Create job wizard (ingest method, start date).
- Job detail view (calendar of slots, progress, logs).
- Pause/resume/stop controls.

---

## 10) Data Model (MVP)

### Tables (conceptual)
- `projects`
- `templates`
- `pillars`
- `jobs`
- `posts`
- `slides`
- `assets`
- `events_log`

(See Codex Pack for concrete SQL and schemas.)

---

## 11) Worker Design

### Renderer worker
- Trigger: post becomes `APPROVED` or edited in review
- Output: `RENDERED` + assets

### Publisher worker
- Every minute:
  - select due slot windows
  - publish next eligible post (APPROVED + RENDERED)
  - update status + logs

### Skip strategy (recommended)
- Do not “shift schedules” aggressively; publish next eligible item at slot time.

---

## 12) Validation Rules

### Template validation
- manifest present and valid
- slide_count within allowed range
- required placeholders exist

### IG validation
- each image meets JPEG/size/aspect constraints
- caption/hashtags within configured limits

### TikTok validation
- rely on API error responses; surface actionable errors.

---

## 13) Observability & Error Handling

### Logging
- Every render and publish attempt writes an event log record.

### Retries
- Retry transient errors (network/429/5xx) with backoff up to max attempts.
- Do not retry validation errors; return to review.

### Dead-letter
- After max retries mark `FAILED` and surface in UI.

---

## Appendix A — Template Manifest (Example)
```json
{
  "template_version": "1.0",
  "output": { "width": 1080, "height": 1350, "format": "jpeg", "quality": 90 },
  "slide_count": 10,
  "slides": [
    {
      "index": 1,
      "background": "assets/bg_01.png",
      "placeholders": [
        {
          "key": "headline",
          "x": 80, "y": 140, "w": 920, "h": 220,
          "font_family": "Inter",
          "font_size": 72,
          "min_font_size": 44,
          "line_height": 1.1,
          "align": "left",
          "fit_mode": "SHRINK_TO_FIT",
          "max_lines": 3
        }
      ]
    }
  ]
}
```
