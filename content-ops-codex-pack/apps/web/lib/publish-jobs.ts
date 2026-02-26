import { createSupabaseServerClient } from "./supabase";

type EnqueueResult = {
  created: number;
  skipped: number;
  reason?: string;
};

type RetryResult = {
  retried: number;
  skipped: number;
  reason?: string;
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
    return { created: 0, skipped: 0, reason: "no_platform_enabled" };
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("publish_jobs")
    .select("platform")
    .eq("post_id", post.id)
    .in("platform", platforms);
  if (existingError) {
    throw new Error(`publish_jobs_existing_fetch_failed:${existingError.message}`);
  }

  const existingPlatforms = new Set((existingRows || []).map(row => row.platform));
  const insertPayload = platforms
    .filter(platform => !existingPlatforms.has(platform))
    .map(platform => ({
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
    }));

  if (!insertPayload.length) {
    return { created: 0, skipped: platforms.length };
  }

  const { error: insertError } = await supabase.from("publish_jobs").insert(insertPayload);
  if (insertError) {
    throw new Error(`publish_jobs_insert_failed:${insertError.message}`);
  }

  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "PUBLISH_JOBS_ENQUEUED_MANUAL",
    payload: { created: insertPayload.length, skipped: platforms.length - insertPayload.length }
  });

  return { created: insertPayload.length, skipped: platforms.length - insertPayload.length };
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
