import { createSupabaseServerClient } from "./supabase";

type EnqueueResult = {
  created: number;
  reactivated: number;
  skipped: number;
  reason?: string;
};

type RetryResult = {
  retried: number;
  skipped: number;
  reason?: string;
};

type BulkRetryResult = {
  retried: number;
  posts: number;
  skipped: number;
  reason?: string;
};

type BulkRetryOptions = {
  requestedBy?: string;
  source?: string;
};

const FAILED_PUBLISH_STATUSES = ["FAILED_FINAL", "FAILED_RETRYABLE"];

function getEnabledPlatforms(publishPlatforms: unknown) {
  const source =
    publishPlatforms && typeof publishPlatforms === "object"
      ? (publishPlatforms as Record<string, unknown>)
      : {};
  const platforms: string[] = [];
  if (source.instagram !== false) platforms.push("instagram");
  if (source.tiktok === true) platforms.push("tiktok");
  return platforms;
}

function buildIdempotencyKey(postId: string, platform: string) {
  return `${postId}:${platform}`;
}

export async function enqueuePublishJobsForPostId(postId: string): Promise<EnqueueResult> {
  const normalizedPostId = String(postId || "").trim();
  if (!normalizedPostId) {
    throw new Error("post_id_required");
  }

  const supabase = createSupabaseServerClient();
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,status,project_id,job_id,publish_platforms,scheduled_at")
    .eq("id", normalizedPostId)
    .single();
  if (postError || !post?.id) {
    throw new Error("post_not_found");
  }
  if (post.status !== "RENDERED") {
    throw new Error(`post_not_rendered:${post.status}`);
  }

  const platforms = getEnabledPlatforms(post.publish_platforms);
  if (!platforms.length) {
    return { created: 0, reactivated: 0, skipped: 0, reason: "no_platform_enabled" };
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("publish_jobs")
    .select("id,platform,status")
    .eq("post_id", post.id)
    .in("platform", platforms);
  if (existingError) {
    throw new Error(`publish_jobs_existing_fetch_failed:${existingError.message}`);
  }

  const existingByPlatform = new Map(
    (existingRows || []).map(row => [String(row.platform), { id: String(row.id), status: String(row.status || "") }])
  );
  const insertPayload: Array<Record<string, unknown>> = [];
  const reactivateIds: string[] = [];
  let skipped = 0;

  for (const platform of platforms) {
    const existing = existingByPlatform.get(platform);
    if (!existing) {
      insertPayload.push({
        project_id: post.project_id,
        job_id: post.job_id || null,
        post_id: post.id,
        platform,
        status: "PENDING",
        idempotency_key: buildIdempotencyKey(post.id, platform),
        attempt_count: 0,
        max_attempts: Number.parseInt(process.env.PUBLISH_MAX_ATTEMPTS || "5", 10),
        scheduled_at: post.scheduled_at || null,
        payload: {}
      });
      continue;
    }

    if (existing.status === "CANCELLED") {
      reactivateIds.push(existing.id);
      continue;
    }

    skipped += 1;
  }

  if (insertPayload.length) {
    const { error: insertError } = await supabase.from("publish_jobs").insert(insertPayload);
    if (insertError) {
      throw new Error(`publish_jobs_insert_failed:${insertError.message}`);
    }
  }

  if (reactivateIds.length) {
    const updatePayload: Record<string, unknown> = {
      status: "PENDING",
      attempt_count: 0,
      next_retry_at: null,
      claimed_at: null,
      claimed_by: null,
      started_at: null,
      completed_at: null,
      published_ids: null,
      last_error_code: null,
      last_error_message: null
    };
    if (post.scheduled_at) {
      updatePayload.scheduled_at = post.scheduled_at;
    }
    const { error: reactivateError } = await supabase
      .from("publish_jobs")
      .update(updatePayload)
      .in("id", reactivateIds);
    if (reactivateError) {
      throw new Error(`publish_jobs_reactivate_failed:${reactivateError.message}`);
    }
  }

  if (!insertPayload.length && !reactivateIds.length) {
    return { created: 0, reactivated: 0, skipped, reason: "publish_jobs_already_present" };
  }

  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "PUBLISH_JOBS_ENQUEUED_MANUAL",
    payload: {
      created: insertPayload.length,
      reactivated: reactivateIds.length,
      skipped
    }
  });

  return { created: insertPayload.length, reactivated: reactivateIds.length, skipped };
}

export async function retryFailedPublishJobsForPostId(postId: string): Promise<RetryResult> {
  const normalizedPostId = String(postId || "").trim();
  if (!normalizedPostId) {
    throw new Error("post_id_required");
  }

  const supabase = createSupabaseServerClient();
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,status,project_id,job_id,scheduled_at")
    .eq("id", normalizedPostId)
    .single();
  if (postError || !post?.id) {
    throw new Error("post_not_found");
  }

  const { data: failedRows, error: failedError } = await supabase
    .from("publish_jobs")
    .select("id,status")
    .eq("post_id", post.id)
    .in("status", FAILED_PUBLISH_STATUSES);
  if (failedError) {
    throw new Error(`publish_jobs_failed_fetch_failed:${failedError.message}`);
  }

  const failedIds = (failedRows || []).map(row => row.id).filter(Boolean);
  if (!failedIds.length) {
    return { retried: 0, skipped: 0, reason: "no_failed_publish_jobs" };
  }

  const updatePayload: Record<string, unknown> = {
    status: "PENDING",
    attempt_count: 0,
    next_retry_at: null,
    claimed_at: null,
    claimed_by: null,
    started_at: null,
    completed_at: null,
    published_ids: null,
    last_error_code: null,
    last_error_message: null
  };
  if (post.scheduled_at) {
    updatePayload.scheduled_at = post.scheduled_at;
  }

  const { error: updateError } = await supabase.from("publish_jobs").update(updatePayload).in("id", failedIds);
  if (updateError) {
    throw new Error(`publish_jobs_retry_failed:${updateError.message}`);
  }

  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "PUBLISH_JOBS_RETRIED_MANUAL",
    payload: { retried: failedIds.length }
  });

  return { retried: failedIds.length, skipped: 0 };
}

export async function retryFailedPublishJobsBulk(options: BulkRetryOptions = {}): Promise<BulkRetryResult> {
  const requestedBy = String(options.requestedBy || "").trim() || "queue_ui";
  const source = String(options.source || "").trim() || "queue_bulk_requeue";
  const bulkRunId = `bulk_retry_${Date.now()}`;
  const supabase = createSupabaseServerClient();
  const { data: failedRows, error: failedError } = await supabase
    .from("publish_jobs")
    .select("id,post_id,project_id,job_id,status")
    .in("status", FAILED_PUBLISH_STATUSES);
  if (failedError) {
    throw new Error(`publish_jobs_bulk_fetch_failed:${failedError.message}`);
  }

  const rows = (failedRows || []).filter(row => row.id && row.post_id && row.project_id);
  if (!rows.length) {
    return { retried: 0, posts: 0, skipped: 0, reason: "no_failed_publish_jobs" };
  }

  const groupedByPost = new Map<
    string,
    { projectId: string; jobId: string | null; publishJobIds: string[] }
  >();
  for (const row of rows) {
    const postId = String(row.post_id);
    const current = groupedByPost.get(postId) || {
      projectId: String(row.project_id),
      jobId: row.job_id ? String(row.job_id) : null,
      publishJobIds: []
    };
    current.publishJobIds.push(String(row.id));
    groupedByPost.set(postId, current);
  }

  const postIds = Array.from(groupedByPost.keys());
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("id,scheduled_at")
    .in("id", postIds);
  if (postsError) {
    throw new Error(`publish_jobs_bulk_posts_fetch_failed:${postsError.message}`);
  }
  const scheduledByPost = new Map<string, string | null>(
    (posts || []).map(post => [String(post.id), post.scheduled_at || null])
  );

  const allFailedIds = rows.map(row => String(row.id));
  const resetPayload = {
    status: "PENDING",
    attempt_count: 0,
    next_retry_at: null,
    claimed_at: null,
    claimed_by: null,
    started_at: null,
    completed_at: null,
    published_ids: null,
    last_error_code: null,
    last_error_message: null
  };

  const { error: resetError } = await supabase
    .from("publish_jobs")
    .update(resetPayload)
    .in("id", allFailedIds);
  if (resetError) {
    throw new Error(`publish_jobs_bulk_retry_failed:${resetError.message}`);
  }

  for (const [postId, group] of groupedByPost.entries()) {
    const scheduledAt = scheduledByPost.get(postId);
    if (!scheduledAt) continue;
    const { error: scheduledError } = await supabase
      .from("publish_jobs")
      .update({ scheduled_at: scheduledAt })
      .in("id", group.publishJobIds);
    if (scheduledError) {
      throw new Error(`publish_jobs_bulk_schedule_sync_failed:${scheduledError.message}`);
    }
  }

  const auditRows = Array.from(groupedByPost.entries()).map(([postId, group]) => ({
    project_id: group.projectId,
    job_id: group.jobId,
    post_id: postId,
    type: "PUBLISH_JOBS_RETRIED_BULK",
    payload: {
      retried: group.publishJobIds.length,
      requested_by: requestedBy,
      source,
      bulk_run_id: bulkRunId
    }
  }));
  const { error: eventError } = await supabase.from("events_log").insert(auditRows);
  if (eventError) {
    throw new Error(`publish_jobs_bulk_audit_failed:${eventError.message}`);
  }

  return { retried: allFailedIds.length, posts: groupedByPost.size, skipped: 0 };
}
