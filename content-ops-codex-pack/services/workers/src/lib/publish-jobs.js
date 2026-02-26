export const PUBLISH_JOB_STATUS = Object.freeze({
  PENDING: "PENDING",
  SENDING: "SENDING",
  PUBLISHED: "PUBLISHED",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  FAILED_FINAL: "FAILED_FINAL",
  CANCELLED: "CANCELLED"
});

const ACTIVE_STATUSES = new Set([
  PUBLISH_JOB_STATUS.PENDING,
  PUBLISH_JOB_STATUS.SENDING,
  PUBLISH_JOB_STATUS.FAILED_RETRYABLE
]);

const TERMINAL_STATUSES = new Set([
  PUBLISH_JOB_STATUS.PUBLISHED,
  PUBLISH_JOB_STATUS.FAILED_FINAL,
  PUBLISH_JOB_STATUS.CANCELLED
]);

function toIso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

function getEnabledPlatforms(publishPlatforms) {
  const source = publishPlatforms && typeof publishPlatforms === "object" ? publishPlatforms : {};
  const platforms = [];
  if (source.instagram !== false) platforms.push("instagram");
  if (source.tiktok === true) platforms.push("tiktok");
  return platforms;
}

export function buildIdempotencyKey(postId, platform) {
  return `${postId}:${platform}`;
}

export async function enqueuePublishJobsForPost({
  supabase,
  post,
  maxAttempts = Number.parseInt(process.env.PUBLISH_MAX_ATTEMPTS || "5", 10)
}) {
  const platforms = getEnabledPlatforms(post.publish_platforms);
  if (!platforms.length) return { created: 0, skipped: 0, reason: "no_platform_enabled" };

  const { data: existingRows, error: existingError } = await supabase
    .from("publish_jobs")
    .select("id,platform,status")
    .eq("post_id", post.id)
    .in("platform", platforms);
  if (existingError) {
    throw new Error(`publish_jobs_existing_fetch_failed:${existingError.message}`);
  }

  const existingByPlatform = new Map((existingRows || []).map(row => [row.platform, row]));
  const insertPayload = [];
  let skipped = 0;

  for (const platform of platforms) {
    const existing = existingByPlatform.get(platform);
    if (existing) {
      if (TERMINAL_STATUSES.has(existing.status)) {
        skipped += 1;
        continue;
      }
      skipped += 1;
      continue;
    }

    insertPayload.push({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      platform,
      status: PUBLISH_JOB_STATUS.PENDING,
      idempotency_key: buildIdempotencyKey(post.id, platform),
      attempt_count: 0,
      max_attempts: maxAttempts,
      scheduled_at: post.scheduled_at || null,
      next_retry_at: null,
      claimed_at: null,
      claimed_by: null,
      started_at: null,
      completed_at: null,
      published_ids: null,
      last_error_code: null,
      last_error_message: null,
      payload: {}
    });
  }

  if (!insertPayload.length) return { created: 0, skipped };

  const { error: insertError } = await supabase.from("publish_jobs").insert(insertPayload);
  if (insertError) {
    throw new Error(`publish_jobs_insert_failed:${insertError.message}`);
  }

  return { created: insertPayload.length, skipped };
}

export async function claimPublishJobs({
  supabase,
  workerId,
  limit = Number.parseInt(process.env.PUBLISH_CLAIM_BATCH_SIZE || "5", 10),
  claimStaleSeconds = Number.parseInt(process.env.PUBLISH_CLAIM_STALE_SECONDS || "600", 10)
}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleThreshold = new Date(now.getTime() - claimStaleSeconds * 1000);

  const { data: candidates, error: fetchError } = await supabase
    .from("publish_jobs")
    .select("*")
    .in("status", [PUBLISH_JOB_STATUS.PENDING, PUBLISH_JOB_STATUS.FAILED_RETRYABLE])
    .order("scheduled_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(Math.max(limit * 4, limit));
  if (fetchError) {
    throw new Error(`publish_jobs_claim_fetch_failed:${fetchError.message}`);
  }

  const due = (candidates || []).filter(row => {
    const scheduledAt = row.scheduled_at ? new Date(row.scheduled_at) : null;
    const retryAt = row.next_retry_at ? new Date(row.next_retry_at) : null;
    const claimedAt = row.claimed_at ? new Date(row.claimed_at) : null;
    const scheduleReady = !scheduledAt || scheduledAt <= now;
    const retryReady = !retryAt || retryAt <= now;
    const claimAvailable = !claimedAt || claimedAt <= staleThreshold;
    return scheduleReady && retryReady && claimAvailable;
  });

  const claimed = [];
  for (const row of due.slice(0, limit)) {
    const { data: updated, error: updateError } = await supabase
      .from("publish_jobs")
      .update({
        status: PUBLISH_JOB_STATUS.SENDING,
        claimed_at: nowIso,
        claimed_by: workerId,
        started_at: row.started_at || nowIso,
        next_retry_at: null,
        attempt_count: (row.attempt_count || 0) + 1
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("*")
      .single();
    if (updateError || !updated) continue;
    claimed.push(updated);
  }

  return claimed;
}

export async function markPublishJobPublished({
  supabase,
  publishJobId,
  publishedIds = null
}) {
  const { error } = await supabase
    .from("publish_jobs")
    .update({
      status: PUBLISH_JOB_STATUS.PUBLISHED,
      published_ids: publishedIds,
      completed_at: toIso(new Date()),
      claimed_at: null,
      claimed_by: null,
      next_retry_at: null,
      last_error_code: null,
      last_error_message: null
    })
    .eq("id", publishJobId)
    .eq("status", PUBLISH_JOB_STATUS.SENDING);
  if (error) throw new Error(`publish_jobs_mark_published_failed:${error.message}`);
}

export async function markPublishJobFailed({
  supabase,
  publishJob,
  errorCode,
  errorMessage,
  forceFinal = false,
  retryDelaySeconds = Number.parseInt(process.env.PUBLISH_RETRY_DELAY_SECONDS || "300", 10)
}) {
  const now = new Date();
  const attempts = Number.parseInt(String(publishJob.attempt_count || 0), 10);
  const maxAttempts = Number.parseInt(String(publishJob.max_attempts || 5), 10);
  const retryable = !forceFinal && attempts < maxAttempts;
  const nextRetryAt = retryable ? new Date(now.getTime() + retryDelaySeconds * 1000) : null;

  const { error } = await supabase
    .from("publish_jobs")
    .update({
      status: retryable ? PUBLISH_JOB_STATUS.FAILED_RETRYABLE : PUBLISH_JOB_STATUS.FAILED_FINAL,
      next_retry_at: retryable ? toIso(nextRetryAt) : null,
      completed_at: retryable ? null : toIso(now),
      claimed_at: null,
      claimed_by: null,
      last_error_code: errorCode || "PUBLISH_FAILED",
      last_error_message: String(errorMessage || "publish_failed")
    })
    .eq("id", publishJob.id)
    .eq("status", PUBLISH_JOB_STATUS.SENDING);
  if (error) throw new Error(`publish_jobs_mark_failed:${error.message}`);
}

export async function cancelActivePublishJobsForPost({ supabase, postId }) {
  const { error } = await supabase
    .from("publish_jobs")
    .update({
      status: PUBLISH_JOB_STATUS.CANCELLED,
      completed_at: toIso(new Date()),
      claimed_at: null,
      claimed_by: null,
      next_retry_at: null
    })
    .eq("post_id", postId)
    .in("status", Array.from(ACTIVE_STATUSES));
  if (error) throw new Error(`publish_jobs_cancel_failed:${error.message}`);
}
