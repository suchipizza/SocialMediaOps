import os from "node:os";

export const WORKER_HEARTBEAT_STATUS = Object.freeze({
  STARTING: "STARTING",
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  DEGRADED: "DEGRADED",
  STOPPED: "STOPPED"
});

export const WORKER_HEARTBEAT_TYPE = Object.freeze({
  SUPERVISOR: "SUPERVISOR",
  RENDERER: "RENDERER",
  PUBLISHER: "PUBLISHER"
});

async function ensureHeartbeatRow({
  supabase,
  workerId,
  workerType,
  status,
  metadata
}) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("worker_heartbeats").upsert(
    {
      worker_id: workerId,
      worker_type: workerType,
      status,
      hostname: os.hostname(),
      pid: process.pid,
      started_at: nowIso,
      last_seen_at: nowIso,
      metadata: metadata || {}
    },
    {
      onConflict: "worker_id",
      ignoreDuplicates: true
    }
  );
  if (error) {
    throw new Error(`worker_heartbeat_ensure_failed:${error.message}`);
  }
}

export async function touchWorkerHeartbeat({
  supabase,
  workerId,
  workerType = WORKER_HEARTBEAT_TYPE.SUPERVISOR,
  status = WORKER_HEARTBEAT_STATUS.IDLE,
  metadata = {},
  lastError = null
}) {
  await ensureHeartbeatRow({
    supabase,
    workerId,
    workerType,
    status,
    metadata
  });

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("worker_heartbeats")
    .update({
      status,
      hostname: os.hostname(),
      pid: process.pid,
      last_seen_at: nowIso,
      metadata,
      last_error: lastError
    })
    .eq("worker_id", workerId);
  if (error) {
    throw new Error(`worker_heartbeat_touch_failed:${error.message}`);
  }
}

export async function cleanupStoppedWorkerHeartbeats({
  supabase,
  retentionDays = Number.parseInt(process.env.WORKER_HEARTBEAT_RETENTION_DAYS || "7", 10)
}) {
  const keepDays = Number.isFinite(retentionDays) ? Math.max(1, retentionDays) : 7;
  const cutoffIso = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("worker_heartbeats")
    .delete({ count: "exact" })
    .eq("status", WORKER_HEARTBEAT_STATUS.STOPPED)
    .lt("last_seen_at", cutoffIso);
  if (error) {
    throw new Error(`worker_heartbeat_cleanup_failed:${error.message}`);
  }
  return {
    deleted: Math.max(count || 0, 0),
    cutoff_iso: cutoffIso
  };
}
