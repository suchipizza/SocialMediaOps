# PRD Diff — Add Format C (React/Vite Template Pack) + Template Upload Preview

This document is designed to be handed to Codex as a **single, smooth code-change instruction**.  
It includes:

1) A **unified diff** patch against `docs/PRD.md` (or your PRD file).  
2) The **implementation notes** Codex should follow for template detection, preview generation, and renderer changes.

---

## 1) Unified Diff Patch (apply to PRD)

> Apply this patch to the PRD file used in your repo (`docs/PRD.md` or equivalent).  
> If the headings differ slightly, Codex should locate the matching sections by title and apply the same changes.

```diff
--- a/docs/PRD.md
+++ b/docs/PRD.md
@@
-### Template Pack (no Figma integration)
-The app does **not** parse `.fig` files. Users upload a **Template Pack** as a `.zip` in one of two supported formats:
+### Template Pack (no Figma integration)
+The app does **not** parse `.fig` files. Users upload a **Template Pack** as a `.zip` in one of three supported formats:

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

+**Format C: React/Vite Template Pack (code-based templates)**
+- A `.zip` containing a Vite + React project that renders a single slide deterministically from query parameters.
+- Required:
+  - `package.json`
+  - `vite.config.ts` (or `vite.config.js`)
+  - `index.html`
+  - `src/main.tsx`
+  - `src/App.tsx`
+  - optional `src/index.css` and component files
+  - `manifest.json` (Format C manifest; see below)
+- Rendering contract:
+  - Template must support: `GET /?slide=<1..N>&data=<base64url(JSON)>`
+  - Template must render exactly one slide at the manifest output size per request.
+- Security: Format C packs execute arbitrary JS. Renderer MUST build+render in an isolated environment (container/sandbox) with network egress disabled where feasible.

@@
 ### 6.2 Templates
 **Create**
 - Upload `.zip` template pack
 - Fields: name, platform scope (IG/TikTok/both), default output format (e.g., 1080×1350)
 - Validate `manifest.json` schema.
+ - Detect template format:
+   - Format A: contains `template.html` + `manifest.json`
+   - Format B: contains `/backgrounds/` + `manifest.json`
+   - Format C: contains `package.json` + `vite.config.*` + `src/App.tsx` + `manifest.json`

 **Manage**
 - List/rename/delete templates.
 - Deleting template blocked if referenced by active pillars/jobs unless user reassigns.

 **Placeholders**
 - Minimum placeholders per slide: `headline`, `body`, `footer`, `page_number`.

+**Template Upload Preview (MVP requirement)**
+- After upload and manifest validation, Content Ops MUST generate a preview carousel with placeholder text and display it in the UI.
+- Preview output:
+  - Render and show slide thumbnails (1..N) in a “Template Preview” page.
+  - Use a fixed placeholder payload:
+    - `headline`: "SAMPLE HEADLINE"
+    - `body`: "Sample body text to test wrapping and fit. Keep this text long enough to force fitting."
+    - `footer`: "us.v2"
+    - `page_number`: "1/N"
+    - For the last slide, include a CTA placeholder: "Sample CTA text. Link in bio."
+- Preview should be generated per template version (hash) and cached.
+- If preview render fails:
+  - Template status becomes `INVALID_RENDER`
+  - UI shows actionable error logs and blocks assignment to pillars.

@@
 ## 7) Rendering Requirements (Playwright)
@@
 ### Rendering pipeline
 1) Take approved post + template pack
 2) Substitute placeholders into HTML
 3) Render each slide via Playwright
 4) Export images to storage; store stable URLs
 5) Attach assets to post

+### Format C rendering pipeline (Playwright + Vite)
+1) Unzip template pack to an isolated sandbox directory
+2) Run `npm ci` and `npm run build` once per template hash; cache the build artifact (`dist/`)
+3) For each slide `i`:
+   - Create JSON payload `{ output, post }`, base64url-encode it
+   - Load `dist/index.html?slide=i&data=<...>` in Playwright
+   - Set viewport to `{ width, height }` per manifest output
+   - Screenshot to image buffer
+4) Upload images, store in `assets`, mark post `RENDERED`

+### Format C manifest (minimum)
+`manifest.json` must include:
+- `template_format`: `"react-vite-v1"`
+- `template_version`: string
+- `output`: `{ width, height, format, quality }`
+- `slide_count`: integer
+- `render`: `{ mode: "querystring", query: { slide: "slide", data: "data" } }`
```

---

## 2) Implementation Notes (Codex guidance)

These are **non-negotiable** for a smooth implementation.

### 2.1 Template format detection (server-side)
When a template zip is uploaded:
- Unzip into a temp directory
- Detect:
  - **A** if `template.html` and `manifest.json` exist at root (or known folder)
  - **B** if `/backgrounds/` exists and `manifest.json` exists
  - **C** if `package.json` exists AND `vite.config.*` exists AND `src/App.tsx` exists AND `manifest.json` exists
- Persist `template.format` in DB: `"A" | "B" | "C"`

### 2.2 Template Upload Preview generation (required for Format A/B/C)
On successful upload + manifest validation:
- Generate preview assets using a fixed placeholder payload.
- Store preview images in storage.
- Store preview URLs in DB (`template_previews` table or `templates.preview_assets` jsonb).
- If preview fails:
  - Mark template status `INVALID_RENDER` and block assignment to pillars.

### 2.3 Format C renderer caching (required)
To avoid rebuilding on every render:
- Hash the zip contents (`sha256`) and use it as `template_hash`.
- Cache compiled `dist/` per template_hash with TTL (e.g. 30 days).
- Build steps:
  - `npm ci`
  - `npm run build`
- Rendering uses Playwright against `file://.../dist/index.html?...` with viewport set.

---

## 3) Acceptance Criteria (for this change)
- Uploading a Format C zip (Vite/React project) succeeds and is detected as Format C.
- After upload, Content Ops generates and displays a preview carousel of N slides with placeholder text.
- Rendering a real post using Format C produces N images of the expected size.
- Preview failures are visible with actionable logs and prevent pillar assignment.

---
