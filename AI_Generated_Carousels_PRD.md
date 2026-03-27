# PRD — AI-Generated Carousel Pipeline for Content Ops Web App

Version: 1.0  
Date: 2026-03-27  
Owner: Product / Engineering  
Target: Codex implementation handoff

---

## 1. Executive Summary

This PRD defines an additive AI-generated carousel pipeline inside the existing Content Ops web app.

The current system already supports an approval-first workflow for template-driven posts: create projects, create jobs, review drafts in `/queue`, render carousel assets, schedule posts, and publish to Instagram and TikTok. That workflow must remain unchanged and fully operational. The new system adds a parallel path for fully AI-generated carousel posts, including text generation, visual-spine generation, image-prompt generation, image generation, human review, packaging, scheduling, and publishing.

Key product intent:
- keep the existing template-based workflow untouched
- add a reusable global niche library under `/AI-generated`
- store all prompts as editable markdown files, not hard-coded logic
- run a structured, validated workflow graph in software while keeping prompt content editable
- support topic-agnostic usage, not only relationship content
- allow text review before image generation
- allow image review before final packaging/publishing
- save learning metadata for future optimization loops

This PRD is intentionally implementation-ready: it defines product scope, UX, orchestration, data model, job states, prompt versioning, failure handling, and a Codex-oriented build plan.

---

## 2. Problem

The current app can reliably process template-based carousels, but it still depends on pre-authored scripts or imported content and on a template rendering path. That works for structured production, but it does not cover the desired future state where the app can:
- store a niche definition and content system as editable source files
- generate full carousel text batches automatically
- transform that text into a coherent visual world
- generate one final slide image per slide
- preview and edit caption, CTA, and hashtags in the queue
- publish AI-generated carousels using the same scheduling and approval philosophy as the existing pipeline

At the same time, prompt iteration must remain fast and manual. The admin must be able to replace a markdown file in the UI and have new jobs immediately use the updated version, without code changes.

---

## 3. Product Goals

### 3.1 Primary goals

1. Add a new `/AI-generated` area for managing reusable niche configurations.
2. Allow jobs to be created with a new ingestion mode: `AI_GENERATED`.
3. Generate batches of carousel posts from prompt assets plus niche source files.
4. Preserve the current approval-first workflow and queue behavior.
5. Support human approval after text generation and after image generation.
6. Support editing caption, CTA, and hashtags directly in the queue preview.
7. Freeze prompt versions per job for reproducibility and debugging.
8. Save metadata and execution traces so future optimization features can learn from outputs and performance.

### 3.2 Secondary goals

1. Make the system topic-agnostic so the same engine can later power non-relationship niches such as mountain sports.
2. Introduce provider/model abstraction for text, reasoning/orchestration, and image generation.
3. Support pillar rotation, sub-angle rotation, activation/deactivation, and weighted prioritization.
4. Make retries stage-specific so one failed step does not restart the whole carousel.

---

## 4. Non-Goals for v1

1. Replacing or refactoring the existing template workflow.
2. Free-form workflow execution based on arbitrary markdown instructions.
3. Multi-language output beyond a single enabled language.
4. Multiple slide-count formats beyond the standard 10-slide carousel.
5. Multiple approval-flow variants in the UI.
6. Automated prompt optimization that writes new markdown assets.
7. Advanced analytics beyond metadata capture, execution logs, and existing publish outcomes.

---

## 5. Design Principles

### 5.1 Additive, not disruptive
The AI-generated path must be implemented as a parallel workflow. Existing template jobs, template previews, rendering workers, queue behavior, and publishing flow must continue to work without regression.

### 5.2 Editable prompts, structured execution
Prompt content lives in editable markdown files. Execution order does not. The actual orchestration is represented by validated software stages and a controlled workflow graph.

### 5.3 Reproducibility
Every job must store a frozen snapshot of the exact prompt-file versions, provider choices, and generation settings used to create each post.

### 5.4 Human-in-the-loop by default
The system should generate quickly, but humans retain approval control at the two critical checkpoints: text draft review and image review.

### 5.5 Topic-agnostic architecture
No schema, route, or stage may assume relationship-specific fields. Relationship-specific behavior must come from user-supplied markdown assets.

### 5.6 Optimization-ready foundation
The storage model must support a future feature that analyzes top-performing posts and proposes improved markdown assets, without requiring a schema redesign.

---

## 6. High-Level Solution

Add a new reusable content-source entity called an **AI Niche**. An AI Niche is a global library item, similar in spirit to a reusable template pack, but for AI generation.

Each AI Niche contains:
- metadata and status
- a set of editable markdown source files
- a prompt/provider configuration
- pillar and sub-angle activation rules
- optional weighted mix preferences
- an immutable version history

A user creates a job from `/jobs` and chooses `AI Generated` instead of a template-based ingestion method. The job selects:
- project
- niche
- target post count
- start date
- pillar mix strategy
- number of slides (v1 only allows 10)
- language (v1 only allows English)

The orchestration engine then runs a stage-based pipeline:
1. plan batch distribution across active pillars and sub-angles
2. generate carousel text packs
3. stop for text review
4. for approved text packs, generate visual spine
5. generate image prompts
6. generate slide images
7. stop for image review
8. package approved slide images as final carousel assets
9. hand off to the existing scheduling and publishing pipeline

---

## 7. Scope

### 7.1 In scope for v1

#### New library area: `/AI-generated`
- create AI niche
- upload markdown files by file type
- replace markdown file with a new version
- edit metadata and activation rules
- configure provider/model selections
- preview prompt registry and version history

#### Job support
- create job with source type `AI_GENERATED`
- choose niche
- choose number of posts
- choose start date
- choose pillar mix mode
- choose number of slides, with only `10` enabled
- choose language, with only `English` enabled

#### Generation pipeline
- batch planner
- text generation
- text approval UI
- visual spine generation
- image prompt generation
- image generation
- image approval UI
- final asset packaging
- publish handoff

#### Queue enhancements
- existing carousel preview remains
- caption preview added
- CTA preview added
- hashtags preview added
- inline edit support for caption, CTA, hashtags
- approve-all and per-post approval for text review
- per-post regenerate text action
- approve-all and per-post approval for image review

#### Metadata and logging
- save text pack
- save visual spine
- save image prompts
- save generated images
- save final slide assets
- save caption
- save CTA
- save hashtags
- save tags/metadata
- save execution logs

### 7.2 Out of scope for v1 but explicitly prepared in architecture
- optimizer that suggests or writes new markdown assets from performance data
- multiple image models per niche or per job
- multiple languages
- configurable checkpoint policies in UI
- multiple slide counts
- free-form workflow editing
- auto-generated prompt-authoring assistant for new niche setup

---

## 8. User Personas

### 8.1 Admin / Operator
Creates niches, uploads markdown source files, launches jobs, reviews drafts, approves posts, edits caption and CTA, and monitors failures.

### 8.2 Future optimizer agent
Not part of v1 UI, but the system must preserve enough structured data so a future optimization agent can analyze wins, propose prompt changes, and create draft prompt versions.

---

## 9. Core Concepts

### 9.1 AI Niche
A globally reusable library item containing all prompt assets and generation settings for a specific topical system.

### 9.2 Prompt Asset
An editable markdown file with a typed role in the workflow.

### 9.3 Prompt Asset Version
An immutable version of a prompt asset, created each time a file is replaced.

### 9.4 Niche Snapshot
The exact set of asset versions and provider settings frozen into a job at creation time.

### 9.5 Text Pack
The structured output of the text-generation stage for one carousel post:
- selected pillar
- selected sub-angle
- selected visual world if present
- emotional effect if present
- slide 1..10 content
- caption body
- CTA
- hashtags

### 9.6 Visual Spine
The structured output that defines hidden mechanism, emotional theater, visual world, motifs, contrast system, and slide-by-slide shot logic.

### 9.7 Final Slide Asset
The generated slide image used directly in the published carousel. No template overlay step is applied in this AI-generated path.

---

## 10. Information Architecture and UX

### 10.1 Navigation
Add a new top-level area:
- `/AI-generated`

Do not remove or rename existing areas such as `/Templates`, `/Jobs`, `/Queue`, `/Projects`.

### 10.2 `/AI-generated` list page
The list page shows all niches as a global library.

Each row/card shows:
- niche name
- topic summary
- status: draft, active, archived
- active asset version bundle ID
- default text model
- default reasoning model
- default image model
- number of active pillars
- last updated timestamp

Actions:
- create niche
- open niche
- archive niche
- duplicate niche

### 10.3 `/AI-generated/:nicheId` detail page
Sections:

#### A. Overview
- name
- slug
- description
- status
- default providers/models
- last updated

#### B. Prompt assets
Required file types in v1:
- `NICHE_DESCRIPTION_MD`
- `TEXT_GENERATION_PROMPT_MD`
- `VISUAL_SPINE_PROMPT_MD`
- `IMAGE_PROMPT_PROMPT_MD`
- `CONTENT_PILLARS_MD`
- `CONTENT_OS_MD`
- `WORKFLOW_REFERENCE_MD`

Reserved file types for later:
- `PROMPT_FORMAT_SPEC_MD`
- `OPTIMIZER_GUIDELINES_MD`
- `BRAND_STYLE_NOTES_MD`
- `EXAMPLES_MD`

Per file tile:
- file type
- current version number
- uploaded filename
- checksum/hash
- uploaded at
- uploaded by
- replace file
- download file
- compare against previous version

Rules:
- replacing a file creates a new immutable version
- the newest version becomes active for future jobs immediately
- in-flight jobs continue using their frozen snapshot

#### C. Pillars and sub-angles
Admin controls:
- list pillars discovered from the uploaded markdown asset or manually mapped metadata
- activate/deactivate pillar
- assign pillar weight
- list sub-angles under each pillar
- activate/deactivate sub-angle
- assign sub-angle weight
- set “favor pillar” weighting

This section may begin as a thin parsed view plus manual metadata fields if full markdown parsing is not reliable enough in v1.

#### D. Model configuration
Fields:
- text provider: `openai | anthropic | google`
- text model
- reasoning/orchestration provider: `openai | anthropic | google`
- reasoning/orchestration model
- image provider
- image model
- image size preset
- temperature or equivalent optional params where the provider supports them

v1 constraint:
- architecture supports all three text/reasoning providers
- UI stores image provider/model config
- only one image model may be enabled for production jobs in v1

#### E. Workflow settings
Editable niche-level settings:
- default approval flow: fixed `TEXT_REVIEW -> IMAGE_REVIEW`
- default output slide count: `10`
- default language: `English`
- default batch distribution mode: `AUTO_BALANCED`
- default fallback behavior on stage failure

#### F. Version history
Shows niche-level bundle history:
- bundle version ID
- included file-version IDs
- provider settings
- created timestamp
- notes

### 10.4 `/Jobs` create flow
Existing job wizard remains intact. Add a branch for source type:
- `Template / CSV / Manual / Existing flow`
- `AI Generated`

If `AI Generated` is selected, show:
- project
- start date
- target post count
- AI niche
- pillar mix mode
- number of slides, prefilled `10`, only value allowed in v1
- language, prefilled `English`, only value allowed in v1

Optional advanced section:
- override niche default text model
- override niche default reasoning model
- image model field displayed read-only or single-option in v1
- random seed policy
- concurrency limit

### 10.5 `/Queue` changes
The queue remains the single operational review surface.

For AI-generated posts, add:
- stage badge: text review, image review, packaged, scheduled, published, failed
- carousel preview using final generated slide images
- content preview panel with three editable fields:
  - caption body
  - CTA
  - hashtags
- combined publish preview panel showing the final caption string exactly as it will be published

Queue actions at text review stage:
- approve text
- approve all text in current filter
- regenerate text for this post only
- edit text manually
- reject post

Queue actions at image review stage:
- approve images
- approve all images in current filter
- regenerate images for this post only
- reject post

Important:
- editing caption/CTA/hashtags in the queue must not require rerunning image generation
- if slide text itself is edited after image generation, the post must be sent back to text-approved-but-images-invalid status and images must be regenerated

---

## 11. Functional Requirements

### 11.1 Compatibility with existing workflow
1. Existing template-based jobs must continue to use the current renderer and pipeline unchanged.
2. Existing `/Templates` flows must remain untouched.
3. The new AI-generated mode must not force changes to the existing post-state contract used by scheduling and publishing.
4. Any new tables or state fields must be additive.

### 11.2 Global AI niche library
1. AI niches are global reusable resources, not project-bound by default.
2. Jobs select a niche at creation time.
3. Future project-bound niche support may be added later if needed, but v1 uses global library semantics.

### 11.3 Markdown file handling
1. Prompt assets are stored as files plus parsed metadata.
2. Uploading a replacement file creates a new version record.
3. The latest version becomes the active head for future jobs immediately.
4. In-flight jobs use the exact frozen asset snapshot from job creation.
5. Validation checks:
   - file extension `.md`
   - non-empty content
   - valid file type assignment
   - checksum computed
6. Optional soft validation may check for required headings or placeholders, but v1 must not block use merely because markdown is unstructured.

### 11.4 Structured workflow graph
The execution graph is fixed in software and validated.

v1 graph:
1. `PLAN_BATCH`
2. `GENERATE_TEXT`
3. `WAIT_FOR_TEXT_APPROVAL`
4. `GENERATE_VISUAL_SPINE`
5. `GENERATE_IMAGE_PROMPTS`
6. `GENERATE_SLIDE_IMAGES`
7. `WAIT_FOR_IMAGE_APPROVAL`
8. `PACKAGE_FINAL_ASSETS`
9. `READY_FOR_SCHEDULING`
10. `PUBLISH` via existing pipeline

The uploaded `WORKFLOW_REFERENCE_MD` is reference material for prompt design and future system evolution. It does not become executable workflow code.

### 11.5 Batch planning and rotation rules
Default mode: `AUTO_BALANCED`

Rules:
1. Only active pillars may be used.
2. Only active sub-angles under active pillars may be used.
3. If target post count is greater than or equal to number of active pillars, use each active pillar at least once when possible.
4. Distribute posts across pillars using weighted round robin.
5. Within a pillar, distribute across active sub-angles using weighted round robin.
6. Avoid immediate repetition of the same pillar/sub-angle combination unless the available set is too small.

Supported mix modes in v1:
- `AUTO_BALANCED`
- `WEIGHTED` using pillar and sub-angle weights
- `MANUAL_TARGETS` where the user specifies counts such as `3x Pillar A, 2x Pillar B`

### 11.6 Text generation stage
Inputs:
- frozen niche snapshot
- job settings
- selected pillar/sub-angle assignment for each target post
- language
- slide count

Outputs per post:
- selected pillar
- selected sub-angle
- selected visual world if determinable
- optional emotional effect
- exactly 10 slides
- caption body
- CTA
- exactly configured hashtag count if defined by prompt rules
- raw provider response
- normalized structured JSON object

Text review is required before any image-stage work starts for that post.

### 11.7 Visual spine stage
Inputs:
- approved text pack
- niche assets
- provider settings

Outputs:
- hidden mechanism
- emotional theater
- visual world
- recurring motifs
- contrast system
- slide-by-slide shot plan
- normalized structured JSON
- raw provider response

### 11.8 Image prompt generation stage
Inputs:
- approved text pack
- visual spine
- niche assets

Outputs:
- global style anchor
- slide 1..10 production image prompts
- art direction notes
- normalized structured JSON
- raw provider response

### 11.9 Slide image generation stage
Inputs:
- image prompts
- image provider/model config
- output size preset for Instagram feed carousel

Outputs:
- 10 slide images
- provider job IDs where available
- per-slide generation metadata
- storage URLs

Constraint:
- each generated image is the final slide image for that slide
- no template overlay renderer is used in this path

### 11.10 Image review stage
1. Human review required in v1.
2. User may approve a single post or approve all filtered posts.
3. User may regenerate images for a single post.
4. Regeneration reruns only the necessary stage by default.
5. Regenerating images does not rerun text generation unless explicitly requested.

### 11.11 Packaging stage
Because the AI-generated path creates final slide images directly, packaging is lightweight.

Packaging responsibilities:
- validate slide count = 10
- validate aspect ratio and file format constraints
- optionally compress or convert if required by platform limits
- sort assets in slide order
- create preview bundle for queue viewer
- mark post ready for scheduling

### 11.12 Publishing handoff
Once packaged and approved, the post enters the existing scheduling and publishing system using the same downstream publish logic already defined for the current app.

Caption assembly rule in v1:
`caption_body + "\n\n" + cta + "\n\n" + hashtags_joined`

Hashtag formatting rule:
- store hashtags as a structured list
- preview and publish as a space-separated or newline-separated string per app standard

---

## 12. Provider and Model Abstraction

### 12.1 Providers
The system must support:
- OpenAI
- Anthropic Claude
- Google Gemini

### 12.2 Stage-to-provider mapping
Per niche, the admin can configure:
- text generation provider/model
- reasoning/orchestration provider/model
- image generation provider/model

### 12.3 v1 implementation boundary
1. Text and reasoning provider abstraction should be implemented for all three families.
2. Image generation architecture must be provider-abstracted.
3. Only one image model may be actively supported in production jobs in v1.
4. The UI may store future-ready image provider settings even if only one is enabled.

### 12.4 Provider adapter contract
Every provider adapter must return normalized envelopes:
- `raw_response`
- `normalized_output`
- `usage_metrics`
- `request_id`
- `error_type`
- `provider_metadata`

---

## 13. Prompt Registry and Versioning

### 13.1 Prompt registry goals
- keep prompt files editable
- track every file replacement as a new version
- freeze versions into jobs
- make future optimization features able to propose new versions rather than mutating live ones blindly

### 13.2 Prompt asset types in v1
- `NICHE_DESCRIPTION_MD`
- `TEXT_GENERATION_PROMPT_MD`
- `VISUAL_SPINE_PROMPT_MD`
- `IMAGE_PROMPT_PROMPT_MD`
- `CONTENT_PILLARS_MD`
- `CONTENT_OS_MD`
- `WORKFLOW_REFERENCE_MD`

### 13.3 Versioning rules
1. Every replacement creates a new immutable row in `ai_prompt_asset_versions`.
2. The active head for the niche points to the latest version per asset type.
3. Job creation stores a `niche_snapshot_id` referencing exact asset-version IDs.
4. Published posts always remain traceable to the exact niche snapshot that produced them.

### 13.4 Future optimizer compatibility
The future optimizer must be able to:
- read performance and content metadata
- generate a proposed new markdown file
- store it as a draft version
- let a human promote it to active

The v1 schema must therefore support version status values such as:
- `ACTIVE`
- `DRAFT`
- `ARCHIVED`
- `PROPOSED_BY_OPTIMIZER`

---

## 14. Data Model

This section is conceptual and should map cleanly to SQL tables.

### 14.1 New tables

#### `ai_niches`
Fields:
- `id`
- `name`
- `slug`
- `description`
- `status` (`DRAFT | ACTIVE | ARCHIVED`)
- `default_text_provider`
- `default_text_model`
- `default_reasoning_provider`
- `default_reasoning_model`
- `default_image_provider`
- `default_image_model`
- `default_language`
- `default_slide_count`
- `default_mix_mode`
- `created_at`
- `updated_at`

#### `ai_prompt_assets`
Fields:
- `id`
- `ai_niche_id`
- `asset_type`
- `display_name`
- `active_version_id`
- `created_at`
- `updated_at`

#### `ai_prompt_asset_versions`
Fields:
- `id`
- `prompt_asset_id`
- `version_number`
- `filename`
- `storage_path`
- `checksum`
- `content_text`
- `status`
- `uploaded_by`
- `created_at`

#### `ai_niche_taxonomy`
Stores parsed or manually maintained activation metadata.

Fields:
- `id`
- `ai_niche_id`
- `pillar_key`
- `pillar_name`
- `pillar_is_active`
- `pillar_weight`
- `subangle_key`
- `subangle_name`
- `subangle_is_active`
- `subangle_weight`
- `visual_world_key` nullable
- `visual_world_name` nullable
- `updated_at`

#### `ai_niche_snapshots`
Fields:
- `id`
- `ai_niche_id`
- `bundle_version`
- `text_provider`
- `text_model`
- `reasoning_provider`
- `reasoning_model`
- `image_provider`
- `image_model`
- `language`
- `slide_count`
- `mix_mode`
- `snapshot_json`
- `created_at`

#### `ai_job_configs`
Fields:
- `id`
- `job_id`
- `ai_niche_snapshot_id`
- `target_post_count`
- `mix_mode`
- `mix_config_json`
- `language`
- `slide_count`
- `status`
- `created_at`

#### `ai_post_runs`
One row per AI-generated post inside a job.

Fields:
- `id`
- `post_id`
- `job_id`
- `ai_niche_snapshot_id`
- `planned_pillar_key`
- `planned_subangle_key`
- `selected_visual_world_key` nullable
- `generation_stage`
- `generation_status`
- `retry_count`
- `last_error_code`
- `last_error_message`
- `created_at`
- `updated_at`

#### `ai_post_artifacts`
Stores normalized outputs by artifact type.

Fields:
- `id`
- `ai_post_run_id`
- `artifact_type`
- `version_number`
- `content_json`
- `raw_text`
- `created_at`

Suggested `artifact_type` values:
- `TEXT_PACK`
- `VISUAL_SPINE`
- `IMAGE_PROMPTS`
- `CAPTION`
- `CTA`
- `HASHTAGS`
- `METADATA_TAGS`

#### `ai_generated_assets`
Stores generated image files.

Fields:
- `id`
- `ai_post_run_id`
- `asset_role` (`SLIDE_IMAGE | FINAL_SLIDE_ASSET | PREVIEW_THUMBNAIL`)
- `slide_index`
- `storage_url`
- `mime_type`
- `width`
- `height`
- `file_size_bytes`
- `provider_asset_id` nullable
- `created_at`

#### `ai_generation_events`
Stage-level observability.

Fields:
- `id`
- `ai_post_run_id`
- `stage`
- `event_type`
- `provider`
- `model`
- `request_payload_redacted`
- `response_payload_redacted`
- `latency_ms`
- `usage_json`
- `status`
- `error_json`
- `created_at`

### 14.2 Existing tables to extend minimally

#### `jobs`
Add nullable fields:
- `source_type` with new enum value `AI_GENERATED`
- `ai_job_config_id` nullable

#### `posts`
Keep existing publishing-state contract. Add nullable fields only if needed:
- `content_source_type`
- `caption_body`
- `caption_cta`
- `hashtags_json`
- `language`
- `slide_count`

Important:
Do not break existing template-rendered posts.

---

## 15. State Machines

### 15.1 Existing publish-state machine remains primary
Continue using the current downstream post lifecycle for scheduling/publishing compatibility.

Recommended downstream states remain compatible with existing workflow:
- `DRAFT`
- `READY_FOR_REVIEW`
- `APPROVED`
- `RENDERED` or equivalent ready state
- `SCHEDULED`
- `PUBLISHING`
- `PUBLISHED`
- `FAILED`

### 15.2 AI generation-stage machine
Store AI-specific progress separately so existing post states do not need major changes.

`generation_stage` values:
- `PLAN_BATCH`
- `GENERATE_TEXT`
- `WAIT_FOR_TEXT_APPROVAL`
- `GENERATE_VISUAL_SPINE`
- `GENERATE_IMAGE_PROMPTS`
- `GENERATE_SLIDE_IMAGES`
- `WAIT_FOR_IMAGE_APPROVAL`
- `PACKAGE_FINAL_ASSETS`
- `READY_FOR_SCHEDULING`
- `DONE`
- `FAILED`

`generation_status` values:
- `PENDING`
- `RUNNING`
- `WAITING_FOR_REVIEW`
- `APPROVED`
- `REJECTED`
- `RETRYING`
- `FAILED`

### 15.3 Job states
Keep current job states, but ensure AI jobs can map into them cleanly:
- `RUNNING`
- `PAUSED`
- `STOPPED`
- `COMPLETED`
- `COMPLETED_NO_CONTENT`
- `FAILED`

AI-specific derived statuses may be shown in UI, for example:
- `AWAITING_TEXT_APPROVAL`
- `GENERATING_IMAGES`
- `AWAITING_IMAGE_APPROVAL`

---

## 16. Orchestration Engine

### 16.1 Responsibilities
The orchestration engine is responsible for:
- resolving the frozen niche snapshot
- planning batch distribution across pillars/sub-angles
- enqueuing stage jobs
- enforcing approval checkpoints
- retrying only failed stages
- persisting normalized artifacts and raw logs

### 16.2 Worker separation
Recommended workers/services:
- `ai-batch-planner-worker`
- `ai-text-generation-worker`
- `ai-visual-spine-worker`
- `ai-image-prompt-worker`
- `ai-image-generation-worker`
- `ai-packaging-worker`
- existing `publisher-worker`

### 16.3 Stage idempotency
Each stage must be idempotent with a deterministic run key.

Suggested run key:
`post_id + stage + artifact_input_hash + provider_model + retry_index`

This prevents duplicate artifacts when retries or queue replays happen.

### 16.4 Retry semantics
1. Transient provider/network errors: retry the failed stage only.
2. Validation errors: return to review or mark stage failed with actionable reason.
3. Do not restart the full post pipeline unless the user explicitly requests a full regenerate.

### 16.5 Approval checkpoint policy
Architecture should support configurable checkpoints later, but v1 behavior is fixed:
- stop after text generation
- stop after image generation

---

## 17. Detailed Generation Pipeline

### 17.1 Stage 1: batch planning
Input:
- target post count
- active pillars/sub-angles
- weight settings
- optional manual mix strategy

Output:
- one planned assignment per target post

Acceptance criteria:
- balanced by default
- supports weighted favoritism
- supports manual target counts

### 17.2 Stage 2: generate text
For each planned post assignment:
- assemble prompt inputs from niche snapshot
- call chosen text provider/model
- normalize into text-pack schema
- persist artifacts
- set stage to `WAIT_FOR_TEXT_APPROVAL`

Acceptance criteria:
- exactly 10 slides
- caption present
- CTA present or derivable
- hashtags present
- selected pillar/sub-angle traceable

### 17.3 Stage 3: text review
User may:
- approve
- approve all
- edit text manually
- regenerate text per post
- reject post

Manual text edits must create a new text-pack artifact version.

### 17.4 Stage 4: generate visual spine
Triggered only after text approval.

### 17.5 Stage 5: generate image prompts
Triggered after visual spine completes.

### 17.6 Stage 6: generate slide images
Triggered after image prompts complete.

Validation:
- one image per slide
- correct orientation and minimum dimensions
- store provider IDs when available

### 17.7 Stage 7: image review
User may:
- approve
- approve all
- regenerate images per post
- reject post

If slide text changed since image generation, mark image artifacts stale and require regeneration.

### 17.8 Stage 8: packaging
Sort slide assets, validate compliance, build preview bundle, and hand off to scheduler.

---

## 18. Queue Editing Rules

### 18.1 Editable fields
At minimum, the queue must allow editing of:
- caption body
- CTA
- hashtags

Optional but recommended in v1:
- slide text

### 18.2 Edit impact rules
- editing caption body, CTA, or hashtags does not invalidate images
- editing slide text after images exist invalidates images
- editing taxonomy labels only affects metadata and future reporting

### 18.3 Publish preview
The queue must show the exact final publish payload string so the operator can verify line breaks and hashtag placement.

---

## 19. Validation Rules

### 19.1 Niche validation
- required asset types present before a niche can be used for jobs
- at least one active pillar
- at least one active sub-angle under at least one active pillar
- provider/model selections valid

### 19.2 Job validation
- project required
- niche required for AI-generated mode
- target post count > 0
- start date required
- slide count must equal 10 in v1
- language must equal English in v1

### 19.3 Artifact validation
- text pack contains 10 slides
- image prompt pack contains 10 prompts
- generated assets count = 10
- asset dimensions valid for platform target
- final caption string within configured platform limits

---

## 20. Observability and Logs

For every stage execution, persist:
- stage name
- provider
- model
- start and end time
- latency
- normalized status
- retry number
- redacted request/response references
- usage tokens or provider metrics when available
- error details

The UI should surface:
- per-post execution timeline
- last failed stage
- actionable retry button
- frozen niche snapshot reference

---

## 21. Failure Handling

### 21.1 Failure categories
- provider/network failure
- normalization failure
- content validation failure
- asset validation failure
- human rejection
- publish failure after packaging

### 21.2 Rules
1. Retry only the failed stage.
2. Do not rerun approved text when only image generation fails.
3. Do not rerun images when only caption editing changes.
4. After max retries, mark the stage failed and surface it in the queue and job detail views.
5. Human rejection does not equal system failure; it should move the post to a rejected/rework state.

### 21.3 Dead-letter behavior
After max automatic retries:
- stage status becomes `FAILED`
- post remains in queue with retry action
- job remains active if other posts still have progress paths

---

## 22. Security and Compliance Notes

1. Provider API keys and tokens must be stored encrypted.
2. Raw provider payloads should be redacted before long-term storage if they may include sensitive account data.
3. Job snapshots must be immutable once created.
4. Existing social-account token handling remains unchanged.

---

## 23. Success Metrics

### 23.1 Functional success
- operator can create and run an AI-generated job without using templates
- text approval and image approval both work inside `/queue`
- caption/CTA/hashtags can be edited before publish
- packaged posts publish through existing scheduling flow

### 23.2 Reliability success
- stage retries do not duplicate assets
- one failed stage does not restart full pipeline
- existing template jobs show no regressions

### 23.3 Product success
- prompt-file replacements affect new jobs immediately
- published posts retain exact prompt/version traceability
- metadata is preserved for later optimization workflows

---

## 24. Acceptance Criteria

### 24.1 `/AI-generated`
- admin can create a niche
- admin can upload required markdown assets
- admin can replace a markdown file and see a new version appear
- new jobs use the newest active versions automatically
- old jobs still reference their frozen snapshot

### 24.2 Job creation
- operator can create an AI-generated job from `/jobs`
- operator can choose niche, target post count, start date, mix mode, slide count, language
- slide count defaults to 10 and only supports 10 in v1
- language defaults to English and only supports English in v1

### 24.3 Generation pipeline
- system generates text packs for all planned posts
- queue shows text-review state
- operator can approve all or regenerate per post
- approved posts advance to image stages
- queue shows image-review state
- operator can approve all or regenerate per post
- approved posts package and enter scheduling flow

### 24.4 Queue preview
- carousel preview displays final slide images
- caption body is visible and editable
- CTA is visible and editable
- hashtags are visible and editable
- combined publish preview updates live

### 24.5 Compatibility
- template-based jobs still run unchanged
- existing template preview/render flow remains unchanged
- publish worker still accepts approved packaged posts from both paths

---

## 25. v1 / v2 Boundary

### v1
- one standard 10-slide carousel
- one enabled output language: English
- one enabled image model in production
- one fixed approval flow: text review, then image review
- provider abstraction for OpenAI, Claude, Gemini on text/reasoning stages
- future-ready image provider abstraction

### v2
- multiple languages
- multiple slide counts
- multiple image models
- user-configurable checkpoint policies
- optimizer-generated prompt versions
- richer asset parsing and prompt-quality validation
- project-scoped overrides on top of global niches

---

## 26. Codex-Friendly Implementation Notes

### 26.1 Recommended repository structure

```text
/apps/web
  /app/ai-generated
  /app/jobs
  /app/queue

/packages/core
  /ai-generation
    planner.ts
    orchestrator.ts
    provider-adapters/
    normalizers/
    validators/
    types.ts

/packages/db
  schema/
  migrations/

/packages/workers
  ai-batch-planner-worker.ts
  ai-text-generation-worker.ts
  ai-visual-spine-worker.ts
  ai-image-prompt-worker.ts
  ai-image-generation-worker.ts
  ai-packaging-worker.ts
  publisher-worker.ts
```

### 26.2 Recommended implementation order
1. Add new DB tables and enums.
2. Add `/AI-generated` CRUD and file versioning.
3. Add `AI_GENERATED` branch to job creation.
4. Implement niche snapshot creation.
5. Implement batch planner.
6. Implement text generation plus queue text-review UI.
7. Implement visual spine and image prompt stages.
8. Implement image generation plus queue image-review UI.
9. Implement packaging and existing publish handoff.
10. Add observability and retry tooling.

### 26.3 Strong recommendation for v1
Do not try to parse markdown files into a perfect semantic model on day one. Store the raw file content and support light parsing plus manual activation metadata. This will reduce fragility while still preserving future optimization compatibility.

### 26.4 Suggested normalized schemas

#### Text pack schema
```json
{
  "pillar": "string",
  "sub_angle": "string",
  "visual_world": "string",
  "emotional_effect": "string",
  "slides": [
    { "index": 1, "headline": "string", "body": "string", "visual_direction": "string" }
  ],
  "caption_body": "string",
  "cta": "string",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}
```

#### Visual spine schema
```json
{
  "hidden_mechanism": "string",
  "emotional_theater": "string",
  "visual_world": ["string"],
  "recurring_motifs": ["string"],
  "contrast_system": ["string"],
  "slide_plan": [
    {
      "index": 1,
      "visual_role": "string",
      "shot_type": "string",
      "must_show": "string",
      "variation_note": "string"
    }
  ]
}
```

#### Image prompt schema
```json
{
  "global_style_anchor": "string",
  "slides": [
    { "index": 1, "production_prompt": "string" }
  ],
  "art_direction_notes": {
    "motifs": ["string"],
    "continuity": "string",
    "cohesion": "string",
    "anti_repetition": "string"
  }
}
```

### 26.5 Suggested planner pseudocode
```ts
function planBatch(input: PlannerInput): PlannedPost[] {
  const pillars = getActivePillars(input.niche);
  const targets = resolveTargets(input.targetCount, input.mixMode, input.manualTargets);
  return weightedRoundRobin(pillars, targets).map((pillar) => ({
    pillar,
    subAngle: pickWeightedSubAngle(pillar.activeSubAngles),
  }));
}
```

### 26.6 Suggested invalidation rules
- if text changes after image generation, mark image artifacts stale
- if caption/CTA/hashtags change, do not mark images stale
- if niche asset versions change, in-flight posts are not invalidated because they are snapshot-based

---

## 27. Recommended Internal Metadata Tags

For each generated post, store at minimum:
- pillar
- sub-angle
- hook family if present
- emotional effect
- visual world
- first-slide strength
- save line
- caption CTA type
- performance score

This metadata should be stored even if some values are human-entered or added later after publish.

---

## 28. Open Technical Notes for Engineering

1. The AI-generated path should bypass the Playwright template renderer entirely once slide images are generated, because the images already contain the final slide design.
2. The downstream publisher should still receive the same stable asset list format it expects from rendered template posts.
3. The queue UI is now a critical operational hub for both existing and AI-generated content; changes should be additive, with feature flags if needed.
4. The provider abstraction should be built before too much business logic accumulates around one vendor.

---

## 29. Final Recommendation

Build the AI-generated path as a separate orchestration layer that feeds into the existing scheduling and publishing system, rather than trying to retrofit AI generation into the current template renderer. Keep markdown prompts editable, freeze versions into job snapshots, and make `/queue` the main human-control surface for both text and image approvals. That architecture is the cleanest way to move fast now while leaving room for future prompt optimization, model swaps, and multi-niche expansion.
