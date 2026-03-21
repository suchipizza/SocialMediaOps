import { createHash } from "node:crypto";
import os from "node:os";
import { renderFormatCSlides } from "../../../renderer/src/format-c.js";
import { enqueuePublishJobsForPost } from "./publish-jobs.js";
import { claimWorkerLease, releaseWorkerLease } from "./worker-lease.js";

const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "content-ops";
const DEFAULT_RENDERER_LOCK_KEY = "control:renderer";
const DEFAULT_RENDER_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RENDER_RETRY_BASE_DELAY_SECONDS = 30;
const DEFAULT_RENDER_RETRY_MAX_DELAY_SECONDS = 900;
const DEFAULT_RENDER_RETRY_JITTER_SECONDS = 5;
const DEFAULT_RENDER_POST_TIMEOUT_MS = 180000;

function parseTruthy(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function logStructured(logger, event, fields = {}) {
  logger.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...fields
    })
  );
}

export function defaultRendererWorkerId() {
  return process.env.RENDER_WORKER_ID || `${os.hostname()}:${process.pid}`;
}

function resolveRendererPartitionKey(value) {
  const raw = String(value || process.env.WORKER_RENDERER_PARTITION_KEY || "global").trim();
  return raw || "global";
}

function resolveRendererLockKey(partitionKey) {
  const base = String(process.env.WORKER_RENDERER_LOCK_KEY || DEFAULT_RENDERER_LOCK_KEY).trim() || DEFAULT_RENDERER_LOCK_KEY;
  if (base.endsWith(`:${partitionKey}`)) return base;
  return `${base}:${partitionKey}`;
}

function resolveRendererLeaseSeconds() {
  const parsed = Number.parseInt(process.env.WORKER_RENDERER_LEASE_SECONDS || "900", 10);
  if (!Number.isFinite(parsed)) return 900;
  return Math.max(parsed, 30);
}

function shouldUseRendererConcurrencyGuard() {
  const explicit = String(process.env.WORKER_RENDERER_CONCURRENCY_GUARD || "").trim();
  if (!explicit) return true;
  return parseTruthy(explicit, true);
}

async function claimRendererLease({
  supabase,
  workerId,
  lockKey,
  leaseSeconds,
  partitionKey
}) {
  return claimWorkerLease({
    supabase,
    lockKey,
    holderId: workerId,
    leaseSeconds,
    metadata: {
      worker_type: "RENDERER",
      partition_key: partitionKey,
      hostname: os.hostname(),
      pid: process.pid
    }
  });
}

function parseIntWithMin(value, fallback, min = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(parsed, min);
}

function resolveRenderRetryPolicy(post) {
  return {
    maxAttempts: parseIntWithMin(
      post?.render_max_attempts,
      parseIntWithMin(process.env.RENDER_RETRY_MAX_ATTEMPTS, DEFAULT_RENDER_RETRY_MAX_ATTEMPTS, 1),
      1
    ),
    baseDelaySeconds: parseIntWithMin(
      process.env.RENDER_RETRY_BASE_DELAY_SECONDS,
      DEFAULT_RENDER_RETRY_BASE_DELAY_SECONDS,
      1
    ),
    maxDelaySeconds: parseIntWithMin(
      process.env.RENDER_RETRY_MAX_DELAY_SECONDS,
      DEFAULT_RENDER_RETRY_MAX_DELAY_SECONDS,
      1
    ),
    jitterSeconds: parseIntWithMin(
      process.env.RENDER_RETRY_JITTER_SECONDS,
      DEFAULT_RENDER_RETRY_JITTER_SECONDS,
      0
    )
  };
}

function computeRetryDelaySeconds({ attemptCount, policy }) {
  const exponent = Math.max(attemptCount - 1, 0);
  const base = policy.baseDelaySeconds * (2 ** exponent);
  const capped = Math.min(base, policy.maxDelaySeconds);
  const jitter = Math.floor(Math.random() * (policy.jitterSeconds + 1));
  return capped + jitter;
}

function resolveRenderPostTimeoutMs() {
  const parsed = Number.parseInt(String(process.env.RENDER_POST_TIMEOUT_MS || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RENDER_POST_TIMEOUT_MS;
  return Math.max(parsed, 10000);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`template_pack_fetch_timeout:${timeoutMs}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeErrorCode(raw) {
  const code = String(raw || "RENDER_FAILED").trim().toUpperCase();
  return code.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80) || "RENDER_FAILED";
}

function resolveExpectedSlideCount({ post, slides, template }) {
  const manifestCount = Number.parseInt(String(template?.manifest_json?.slide_count || ""), 10);
  if (Number.isFinite(manifestCount) && manifestCount > 0) {
    return manifestCount;
  }

  const postCount = Number.parseInt(String(post?.slide_count || ""), 10);
  if (Number.isFinite(postCount) && postCount > 0) {
    return postCount;
  }

  return Array.isArray(slides) ? slides.length : 0;
}

function assertRequiredSlidesPresent({ expectedSlideCount, slides }) {
  if (!Number.isFinite(expectedSlideCount) || expectedSlideCount <= 0) {
    throw new Error("slide_count_invalid");
  }

  const available = new Set((slides || []).map(slide => Number.parseInt(String(slide?.slide_index || 0), 10)));
  for (let i = 1; i <= expectedSlideCount; i += 1) {
    if (!available.has(i)) {
      throw new Error(`slide_payload_missing:${i}`);
    }
  }
}

function parseTemplatePackFetchStatus(messageLower) {
  const match = messageLower.match(/template_pack_fetch_failed:(\d{3})/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function classifyRendererError(err) {
  const message = String(err?.message || err || "render_failed");
  const messageLower = message.toLowerCase();
  const explicitCode = normalizeErrorCode(err?.code || message.split(":")[0] || "RENDER_FAILED");

  const fatalPrefixes = [
    "template_not_found",
    "template_invalid_render",
    "template_format_not_supported",
    "format_c_prebuilt_bundle_missing_output",
    "format_c_prebuilt_bundle_cache_invalid",
    "post_template_missing",
    "slides_missing",
    "assets_missing",
    "slide_payload_missing",
    "slide_count_invalid"
  ];
  if (fatalPrefixes.some(prefix => messageLower.startsWith(prefix))) {
    return { retryable: false, errorCode: explicitCode, reason: "fatal_content_or_template" };
  }

  const templatePackStatus = parseTemplatePackFetchStatus(messageLower);
  if (templatePackStatus) {
    const retryable = templatePackStatus === 408 || templatePackStatus === 429 || templatePackStatus >= 500;
    return {
      retryable,
      errorCode: explicitCode,
      reason: retryable ? "template_pack_transient_http" : "template_pack_final_http"
    };
  }

  const transientMarkers = [
    "fetch failed",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "etimedout",
    "network",
    "slide_root_not_ready",
    "execution context was destroyed",
    "target closed",
    "upload_failed",
    "assets_upsert_failed",
    "slides_fetch_failed"
  ];
  if (transientMarkers.some(marker => messageLower.includes(marker))) {
    return { retryable: true, errorCode: explicitCode, reason: "transient_runtime_or_io" };
  }

  return { retryable: false, errorCode: explicitCode, reason: "unknown_final" };
}

async function fetchTemplate(supabase, templateId) {
  const { data, error } = await supabase
    .from("templates")
    .select("id,format,template_pack_url,manifest_json,template_hash,status")
    .eq("id", templateId)
    .single();
  if (error || !data?.id) throw new Error(`template_not_found:${templateId}`);
  if (data.status === "INVALID_RENDER") throw new Error(`template_invalid_render:${templateId}`);
  return data;
}

async function fetchPostPayloads(supabase, postId) {
  const { data: slides, error } = await supabase
    .from("slides")
    .select("slide_index,fields")
    .eq("post_id", postId)
    .order("slide_index", { ascending: true });
  if (error) throw new Error(`slides_fetch_failed:${error.message}`);
  return slides || [];
}

async function uploadRenderedSlides({ supabase, postId, templateHash, output, buffers }) {
  const format = output?.format === "png" ? "png" : "jpeg";
  const ext = format === "png" ? "png" : "jpg";
  const mime = format === "png" ? "image/png" : "image/jpeg";

  const assets = [];
  for (let i = 0; i < buffers.length; i += 1) {
    const slideIndex = i + 1;
    const buffer = buffers[i];
    const storagePath = `renders/${postId}/${templateHash}/slide_${String(slideIndex).padStart(2, "0")}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, buffer, {
        contentType: mime,
        upsert: true
      });
    if (uploadError) throw new Error(`upload_failed:${uploadError.message}`);
    const { data: publicUrl } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);

    assets.push({
      post_id: postId,
      slide_index: slideIndex,
      image_url: publicUrl.publicUrl,
      width: output.width,
      height: output.height,
      bytes: buffer.length,
      mime
    });
  }

  const { error: assetsError } = await supabase
    .from("assets")
    .upsert(assets, { onConflict: "post_id,slide_index" });
  if (assetsError) throw new Error(`assets_upsert_failed:${assetsError.message}`);
}

async function renderPost({ supabase, post, runId = null }) {
  const templateId = post.template_id || post.jobs?.template_id;
  if (!templateId) throw new Error("post_template_missing");

  const template = await fetchTemplate(supabase, templateId);
  if (template.format !== "C") throw new Error(`template_format_not_supported:${template.format}`);

  const slides = await fetchPostPayloads(supabase, post.id);
  if (!slides.length) throw new Error("slides_missing");

  const slideCount = resolveExpectedSlideCount({ post, slides, template });
  assertRequiredSlidesPresent({ expectedSlideCount: slideCount, slides });

  const payloads = slides.map(slide => ({
    slide_index: slide.slide_index,
    slide_count: slideCount,
    fields: slide.fields || {}
  }));

  const renderTimeoutMs = resolveRenderPostTimeoutMs();
  const res = await fetchWithTimeout(template.template_pack_url, renderTimeoutMs);
  if (!res.ok) throw new Error(`template_pack_fetch_failed:${res.status}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  const { buffers, output, templateHash } = await withTimeout(
    renderFormatCSlides({
      manifest: template.manifest_json,
      zipBuffer,
      payloads
    }),
    renderTimeoutMs,
    `render_post_timeout:${renderTimeoutMs}`
  );

  const finalHash = template.template_hash || templateHash || createHash("sha256").update(zipBuffer).digest("hex");
  await uploadRenderedSlides({ supabase, postId: post.id, templateHash: finalHash, output, buffers });

  const { error: postUpdateError } = await supabase
    .from("posts")
    .update({ status: "RENDERED", error_code: null, error_message: null, render_next_retry_at: null })
    .eq("id", post.id);
  if (postUpdateError) {
    throw new Error(`posts_mark_rendered_failed:${postUpdateError.message}`);
  }
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "RENDER_SUCCESS",
    payload: { run_id: runId || null, template_id: template.id, slide_count: slideCount }
  });

  try {
    const publishQueueResult = await enqueuePublishJobsForPost({
      supabase,
      post: {
        id: post.id,
        project_id: post.project_id,
        job_id: post.job_id || null,
        publish_platforms: post.publish_platforms,
        scheduled_at: post.scheduled_at || null
      }
    });

    await supabase.from("events_log").insert({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      type: "PUBLISH_JOBS_ENQUEUED",
      payload: {
        run_id: runId || null,
        ...publishQueueResult
      }
    });
  } catch (queueError) {
    await supabase.from("events_log").insert({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      type: "PUBLISH_JOBS_ENQUEUE_FAILED",
      payload: { run_id: runId || null, message: String(queueError?.message || queueError) }
    });
  }
}

async function markRenderAttemptStarted({ supabase, post }) {
  const nextAttempt = parseIntWithMin(post?.render_attempt_count, 0, 0) + 1;
  const policy = resolveRenderRetryPolicy(post);
  const { error } = await supabase
    .from("posts")
    .update({
      render_attempt_count: nextAttempt,
      render_last_attempt_at: new Date().toISOString(),
      render_max_attempts: policy.maxAttempts
    })
    .eq("id", post.id);
  if (error) {
    throw new Error(`render_attempt_start_failed:${error.message}`);
  }
  return {
    ...post,
    render_attempt_count: nextAttempt,
    render_max_attempts: policy.maxAttempts
  };
}

async function markFailed({ supabase, post, err, runId = null }) {
  const message = String(err?.message || err);
  const attemptCount = parseIntWithMin(post?.render_attempt_count, 0, 0);
  const policy = resolveRenderRetryPolicy(post);
  const classified = classifyRendererError(err);
  const isRetryable = classified.retryable && attemptCount < policy.maxAttempts;

  if (isRetryable) {
    const retryDelaySeconds = computeRetryDelaySeconds({ attemptCount, policy });
    const nextRetryAtIso = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();
    const { error: retryUpdateError } = await supabase
      .from("posts")
      .update({
        status: "APPROVED",
        error_code: "RENDER_FAILED_RETRYABLE",
        error_message: message,
        render_next_retry_at: nextRetryAtIso
      })
      .eq("id", post.id);
    if (retryUpdateError) {
      throw new Error(`posts_mark_retry_failed:${retryUpdateError.message}`);
    }
    await supabase.from("events_log").insert({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      type: "RENDER_RETRY_SCHEDULED",
      payload: {
        run_id: runId || null,
        message,
        error_code: classified.errorCode,
        retry_reason: classified.reason,
        attempt_count: attemptCount,
        max_attempts: policy.maxAttempts,
        retry_delay_seconds: retryDelaySeconds,
        next_retry_at: nextRetryAtIso
      }
    });
    return { retryScheduled: true };
  }

  const finalErrorCode =
    attemptCount >= policy.maxAttempts ? "RENDER_MAX_ATTEMPTS_EXCEEDED" : classified.errorCode;
  const { error: finalUpdateError } = await supabase
    .from("posts")
    .update({
      status: "FAILED",
      error_code: finalErrorCode,
      error_message: message,
      render_next_retry_at: null
    })
    .eq("id", post.id);
  if (finalUpdateError) {
    throw new Error(`posts_mark_failed_failed:${finalUpdateError.message}`);
  }
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "RENDER_FAILED",
    payload: {
      run_id: runId || null,
      message,
      final: true,
      error_code: finalErrorCode,
      retry_reason: classified.reason,
      attempt_count: attemptCount,
      max_attempts: policy.maxAttempts
    }
  });
  return { retryScheduled: false };
}

export async function processRendererBatch({
  supabase,
  batchSize = Number.parseInt(process.env.RENDER_BATCH_SIZE || "1", 10),
  runId = null,
  logger = console
}) {
  const nowIso = new Date().toISOString();
  const { data: posts, error } = await supabase
    .from("posts")
    .select(
      "id,project_id,job_id,slide_count,template_id,publish_platforms,scheduled_at,render_attempt_count,render_max_attempts,render_next_retry_at,projects(id),jobs(template_id)"
    )
    .eq("status", "APPROVED")
    .or(`render_next_retry_at.is.null,render_next_retry_at.lte.${nowIso}`)
    // Prioritize overdue/earliest scheduled posts so late items are rendered first.
    .order("scheduled_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(`posts_fetch_failed:${error.message}`);

  let rendered = 0;
  let failed = 0;
  let retryScheduled = 0;
  for (const post of posts || []) {
    const startedPost = await markRenderAttemptStarted({ supabase, post });
    try {
      await renderPost({ supabase, post: startedPost, runId });
      rendered += 1;
    } catch (err) {
      const failResult = await markFailed({ supabase, post: startedPost, err, runId });
      if (failResult.retryScheduled) {
        retryScheduled += 1;
      } else {
        failed += 1;
      }
    }
  }

  logStructured(logger, "renderer.batch_finished", {
    run_id: runId || null,
    fetched: (posts || []).length,
    rendered,
    retry_scheduled: retryScheduled,
    failed
  });

  return { fetched: (posts || []).length, rendered, failed, retryScheduled };
}

export async function runRendererUntilDrained({
  supabase,
  batchSize = Number.parseInt(process.env.RENDER_BATCH_SIZE || "1", 10),
  maxBatches = Number.parseInt(process.env.RENDER_MAX_BATCHES || "0", 10),
  workerId = defaultRendererWorkerId(),
  partitionKey,
  enforceConcurrencyGuard = shouldUseRendererConcurrencyGuard(),
  runId = null,
  logger = console
}) {
  const effectiveRunId = runId || `run_render_${Date.now()}_${workerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const resolvedPartitionKey = resolveRendererPartitionKey(partitionKey);
  const lockKey = resolveRendererLockKey(resolvedPartitionKey);
  const leaseSeconds = resolveRendererLeaseSeconds();
  const renewIntervalMs = Math.max(Math.floor((leaseSeconds * 1000) / 2), 5000);

  let leaseOwned = false;
  let leaseRenewTimer = null;
  let leaseRenewError = null;

  if (enforceConcurrencyGuard) {
    const firstLease = await claimRendererLease({
      supabase,
      workerId,
      lockKey,
      leaseSeconds,
      partitionKey: resolvedPartitionKey
    });
    if (!firstLease.acquired) {
      return {
        batches: 0,
        totalFetched: 0,
        totalRendered: 0,
        totalFailed: 0,
        totalRetryScheduled: 0,
        skipped: true,
        skipReason: "renderer_already_running",
        runId: effectiveRunId,
        workerId,
        lockKey,
        partitionKey: resolvedPartitionKey,
        lockHolderId: firstLease.holderId || null,
        lockExpiresAt: firstLease.leaseExpiresAt || null
      };
    }
    leaseOwned = true;

    leaseRenewTimer = setInterval(() => {
      void claimRendererLease({
        supabase,
        workerId,
        lockKey,
        leaseSeconds,
        partitionKey: resolvedPartitionKey
      })
        .then(lease => {
          if (!lease.acquired) {
            leaseRenewError = new Error(
              `renderer_lease_lost_to_${lease.holderId || "unknown"}`
            );
          }
        })
        .catch(err => {
          leaseRenewError = err instanceof Error ? err : new Error(String(err || "renderer_lease_renew_failed"));
        });
    }, renewIntervalMs);
    if (typeof leaseRenewTimer.unref === "function") {
      leaseRenewTimer.unref();
    }
  }

  let batches = 0;
  let totalFetched = 0;
  let totalRendered = 0;
  let totalFailed = 0;
  let totalRetryScheduled = 0;

  try {
    while (true) {
      if (leaseRenewError) throw leaseRenewError;
      if (maxBatches > 0 && batches >= maxBatches) break;

      if (enforceConcurrencyGuard) {
        const lease = await claimRendererLease({
          supabase,
          workerId,
          lockKey,
          leaseSeconds,
          partitionKey: resolvedPartitionKey
        });
        if (!lease.acquired) {
          throw new Error(`renderer_lease_lost_to_${lease.holderId || "unknown"}`);
        }
      }

      const batch = await processRendererBatch({
        supabase,
        batchSize,
        runId: effectiveRunId,
        logger
      });
      batches += 1;
      totalFetched += batch.fetched;
      totalRendered += batch.rendered;
      totalFailed += batch.failed;
      totalRetryScheduled += batch.retryScheduled;
      if (batch.fetched === 0) break;
    }
  } finally {
    if (leaseRenewTimer) {
      clearInterval(leaseRenewTimer);
    }
    if (enforceConcurrencyGuard && leaseOwned) {
      try {
        await releaseWorkerLease({
          supabase,
          lockKey,
          holderId: workerId
        });
      } catch {
        // Best-effort release only.
      }
    }
  }

  logStructured(logger, "renderer.run_finished", {
    run_id: effectiveRunId,
    worker_id: workerId,
    partition_key: resolvedPartitionKey,
    batches,
    total_fetched: totalFetched,
    total_rendered: totalRendered,
    total_retry_scheduled: totalRetryScheduled,
    total_failed: totalFailed
  });

  return {
    runId: effectiveRunId,
    batches,
    totalFetched,
    totalRendered,
    totalFailed,
    totalRetryScheduled,
    skipped: false,
    workerId,
    lockKey: enforceConcurrencyGuard ? lockKey : null,
    partitionKey: enforceConcurrencyGuard ? resolvedPartitionKey : null
  };
}
