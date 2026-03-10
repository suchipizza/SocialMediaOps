export const CONTROL_JOB_TYPES = Object.freeze({
  RUN_RENDERER_DRAIN: "RUN_RENDERER_DRAIN",
  RUN_PUBLISHER_ONCE: "RUN_PUBLISHER_ONCE",
  RUN_PUBLISHER_LOOP_START: "RUN_PUBLISHER_LOOP_START",
  RUN_PUBLISHER_LOOP_STOP: "RUN_PUBLISHER_LOOP_STOP"
});

export const CONTROL_JOB_STATUS = Object.freeze({
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  FAILED_FINAL: "FAILED_FINAL",
  CANCELLED: "CANCELLED"
});

function asIso(dateLike) {
  return (dateLike instanceof Date ? dateLike : new Date(dateLike)).toISOString();
}

export async function claimWorkerControlJobs({
  supabase,
  workerId,
  limit = Number.parseInt(process.env.WORKER_CONTROL_CLAIM_BATCH_SIZE || "4", 10),
  claimStaleSeconds = Number.parseInt(process.env.WORKER_CONTROL_CLAIM_STALE_SECONDS || "600", 10)
}) {
  const { data, error } = await supabase.rpc("claim_worker_control_jobs", {
    p_worker_id: workerId,
    p_limit: Number.isNaN(limit) ? 1 : Math.max(limit, 1),
    p_claim_stale_seconds: Number.isNaN(claimStaleSeconds) ? 600 : Math.max(claimStaleSeconds, 1)
  });
  if (error) {
    throw new Error(`worker_control_jobs_claim_failed:${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

export async function markWorkerControlJobRunning({
  supabase,
  job,
  workerId
}) {
  const attempts = Number.parseInt(String(job.attempt_count || 0), 10) || 0;
  const nowIso = asIso(new Date());
  const { data, error } = await supabase
    .from("worker_control_jobs")
    .update({
      status: CONTROL_JOB_STATUS.RUNNING,
      claimed_by: workerId,
      claimed_at: nowIso,
      started_at: nowIso,
      completed_at: null,
      attempt_count: attempts + 1,
      error_code: null,
      error_message: null
    })
    .eq("id", job.id)
    .eq("status", CONTROL_JOB_STATUS.CLAIMED)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`worker_control_jobs_mark_running_failed:${error?.message || "missing_row"}`);
  }
  return data;
}

export async function markWorkerControlJobSucceeded({
  supabase,
  jobId,
  result = {}
}) {
  const { error } = await supabase
    .from("worker_control_jobs")
    .update({
      status: CONTROL_JOB_STATUS.SUCCEEDED,
      result_json: result,
      completed_at: asIso(new Date()),
      claimed_at: null,
      claimed_by: null,
      next_retry_at: null,
      error_code: null,
      error_message: null
    })
    .eq("id", jobId)
    .in("status", [CONTROL_JOB_STATUS.RUNNING, CONTROL_JOB_STATUS.CLAIMED]);
  if (error) {
    throw new Error(`worker_control_jobs_mark_succeeded_failed:${error.message}`);
  }
}

export async function markWorkerControlJobFailed({
  supabase,
  job,
  errorCode,
  errorMessage,
  forceFinal = false,
  retryDelaySeconds = Number.parseInt(process.env.WORKER_CONTROL_RETRY_DELAY_SECONDS || "30", 10)
}) {
  const attempts = Number.parseInt(String(job.attempt_count || 0), 10) || 0;
  const maxAttempts = Number.parseInt(String(job.max_attempts || 5), 10) || 5;
  const retryable = !forceFinal && attempts < maxAttempts;
  const nextRetryAt = retryable
    ? asIso(new Date(Date.now() + Math.max(retryDelaySeconds, 1) * 1000))
    : null;

  const { error } = await supabase
    .from("worker_control_jobs")
    .update({
      status: retryable ? CONTROL_JOB_STATUS.FAILED_RETRYABLE : CONTROL_JOB_STATUS.FAILED_FINAL,
      error_code: String(errorCode || "CONTROL_JOB_FAILED"),
      error_message: String(errorMessage || "control_job_failed"),
      completed_at: retryable ? null : asIso(new Date()),
      next_retry_at: nextRetryAt,
      claimed_at: null,
      claimed_by: null
    })
    .eq("id", job.id)
    .in("status", [CONTROL_JOB_STATUS.RUNNING, CONTROL_JOB_STATUS.CLAIMED]);
  if (error) {
    throw new Error(`worker_control_jobs_mark_failed:${error.message}`);
  }
}

export async function enqueueWorkerControlJob({
  supabase,
  type,
  idempotencyKey,
  scopeKey = null,
  payload = {},
  priority = 0,
  requestedBy = "system",
  scheduledAt = null
}) {
  const body = {
    type,
    status: CONTROL_JOB_STATUS.PENDING,
    idempotency_key: idempotencyKey,
    scope_key: scopeKey,
    payload,
    priority,
    requested_by: requestedBy,
    scheduled_at: scheduledAt
  };
  const { data, error } = await supabase.from("worker_control_jobs").insert(body).select("*").single();
  if (error) {
    throw new Error(`worker_control_jobs_enqueue_failed:${error.message}`);
  }
  return data;
}

