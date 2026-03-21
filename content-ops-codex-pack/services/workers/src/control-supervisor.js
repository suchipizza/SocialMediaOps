import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  claimWorkerControlJobs,
  CONTROL_JOB_TYPES,
  markWorkerControlJobFailed,
  markWorkerControlJobRunning,
  markWorkerControlJobSucceeded,
  touchWorkerControlJobRunning
} from "./lib/control-jobs.js";
import { createSupabaseAdminClient, loadWorkerEnv } from "./lib/runtime.js";
import { runRendererUntilDrained } from "./lib/renderer-runner.js";
import { runPublisherOnce, resolveDryRun } from "./lib/publisher-runner.js";
import {
  cleanupStoppedWorkerHeartbeats,
  touchWorkerHeartbeat,
  WORKER_HEARTBEAT_STATUS,
  WORKER_HEARTBEAT_TYPE
} from "./lib/worker-heartbeat.js";
import { claimWorkerLease, releaseWorkerLease } from "./lib/worker-lease.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const supervisorId = process.env.WORKER_SUPERVISOR_ID || `control:${os.hostname()}:${process.pid}`;
const supervisorLockKey = process.env.WORKER_SUPERVISOR_LOCK_KEY || "control:supervisor:singleton";
const supervisorLeaseSeconds = Number.parseInt(process.env.WORKER_SUPERVISOR_LEASE_SECONDS || "600", 10);
const controlPollMs = Number.parseInt(process.env.WORKER_CONTROL_POLL_MS || "5000", 10);
const controlJobKeepaliveMs = Math.max(
  Number.parseInt(process.env.WORKER_CONTROL_JOB_KEEPALIVE_MS || "30000", 10) || 30_000,
  5_000
);
const controlJobKeepaliveFailureThreshold = Math.max(
  Number.parseInt(process.env.WORKER_CONTROL_JOB_KEEPALIVE_FAILURE_THRESHOLD || "3", 10) || 3,
  1
);
const heartbeatCleanupIntervalMs = Number.parseInt(process.env.WORKER_HEARTBEAT_CLEANUP_INTERVAL_MS || "900000", 10);
const heartbeatRetentionDays = Number.parseInt(process.env.WORKER_HEARTBEAT_RETENTION_DAYS || "7", 10);
let publisherLoopEnabled =
  String(process.env.WORKER_PUBLISHER_LOOP_ENABLED || "false").toLowerCase() === "true";
let lastHeartbeatCleanupMs = 0;
let shouldExit = false;
let shutdownInProgress = false;

function logSupervisor(event, fields = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      supervisor_id: supervisorId,
      ...fields
    })
  );
}

function resolveControlRunId(controlJob) {
  const payloadRunId =
    controlJob?.payload &&
    typeof controlJob.payload === "object" &&
    controlJob.payload.correlation_id
      ? String(controlJob.payload.correlation_id)
      : "";
  if (payloadRunId) return payloadRunId;
  if (controlJob?.id) return `run_control_${controlJob.id}`;
  return `run_control_${Date.now()}_${randomUUID()}`;
}

async function markSupersededSupervisorsStopped({ supabase }) {
  const hostname = os.hostname();
  const { error } = await supabase
    .from("worker_heartbeats")
    .update({
      status: WORKER_HEARTBEAT_STATUS.STOPPED,
      last_error: "superseded_by_new_supervisor"
    })
    .eq("worker_type", WORKER_HEARTBEAT_TYPE.SUPERVISOR)
    .eq("hostname", hostname)
    .neq("worker_id", supervisorId)
    .in("status", [
      WORKER_HEARTBEAT_STATUS.STARTING,
      WORKER_HEARTBEAT_STATUS.IDLE,
      WORKER_HEARTBEAT_STATUS.RUNNING,
      WORKER_HEARTBEAT_STATUS.DEGRADED
    ]);
  if (error) {
    throw new Error(`worker_heartbeat_superseded_mark_failed:${error.message}`);
  }
}

async function runControlJob({ supabase, controlJob, runId }) {
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_RENDERER_DRAIN) {
    const payloadPartition =
      controlJob?.payload && typeof controlJob.payload.partition_key === "string"
        ? String(controlJob.payload.partition_key).trim()
        : "";
    const partitionKey = payloadPartition || String(controlJob.scope_key || "").trim() || "global";
    return runRendererUntilDrained({
      supabase,
      workerId: `${supervisorId}:renderer`,
      partitionKey,
      runId
    });
  }
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_PUBLISHER_ONCE) {
    return runPublisherOnce({
      supabase,
      workerId: `${supervisorId}:publisher-once`,
      dryRun: resolveDryRun(),
      runId
    });
  }
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_PUBLISHER_LOOP_START) {
    publisherLoopEnabled = true;
    return { publisher_loop_enabled: true };
  }
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_PUBLISHER_LOOP_STOP) {
    publisherLoopEnabled = false;
    return { publisher_loop_enabled: false };
  }
  throw new Error(`control_job_type_not_supported:${controlJob.type}`);
}

async function processClaimedControlJobs({ supabase, claimed }) {
  for (const claimedJob of claimed) {
    const runId = resolveControlRunId(claimedJob);
    let runningJob = claimedJob;
    try {
      logSupervisor("control_job.started", {
        run_id: runId,
        control_job_id: claimedJob.id,
        control_job_type: claimedJob.type
      });
      await touchWorkerHeartbeat({
        supabase,
        workerId: supervisorId,
        workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
        status: WORKER_HEARTBEAT_STATUS.RUNNING,
        metadata: {
          publisher_loop_enabled: publisherLoopEnabled,
          current_control_job_id: claimedJob.id,
          current_control_job_type: claimedJob.type
        }
      });
      runningJob = await markWorkerControlJobRunning({
        supabase,
        job: claimedJob,
        workerId: supervisorId
      });
      let keepaliveFailures = 0;
      let keepaliveFatalError = null;
      const keepaliveTick = async () => {
        if (keepaliveFatalError) return;
        try {
          const lease = await renewSupervisorLease({ supabase });
          if (!lease.acquired) {
            throw new Error(`singleton_guard_lost_to_${lease.holderId || "unknown"}`);
          }
          await touchWorkerControlJobRunning({
            supabase,
            jobId: runningJob.id,
            workerId: supervisorId
          });
          await touchWorkerHeartbeat({
            supabase,
            workerId: supervisorId,
            workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
            status: WORKER_HEARTBEAT_STATUS.RUNNING,
            metadata: {
              publisher_loop_enabled: publisherLoopEnabled,
              current_control_job_id: runningJob.id,
              current_control_job_type: runningJob.type,
              current_run_id: runId
            }
          });
          keepaliveFailures = 0;
        } catch (err) {
          keepaliveFailures += 1;
          const message = String(err?.message || err || "control_job_keepalive_failed");
          logSupervisor("control_job.keepalive_failed", {
            run_id: runId,
            control_job_id: runningJob.id,
            control_job_type: runningJob.type,
            failure_count: keepaliveFailures,
            error_message: message
          });
          if (keepaliveFailures >= controlJobKeepaliveFailureThreshold) {
            keepaliveFatalError = new Error(message);
          }
        }
      };

      await keepaliveTick();
      if (keepaliveFatalError) {
        throw keepaliveFatalError;
      }

      const keepaliveTimer = setInterval(() => {
        void keepaliveTick();
      }, controlJobKeepaliveMs);
      if (typeof keepaliveTimer.unref === "function") {
        keepaliveTimer.unref();
      }

      let result;
      try {
        result = await runControlJob({ supabase, controlJob: runningJob, runId });
      } finally {
        clearInterval(keepaliveTimer);
      }
      if (keepaliveFatalError) {
        throw keepaliveFatalError;
      }

      await markWorkerControlJobSucceeded({
        supabase,
        jobId: runningJob.id,
        result:
          result && typeof result === "object"
            ? { ...result, run_id: runId, supervisor_id: supervisorId }
            : { value: result, run_id: runId, supervisor_id: supervisorId }
      });
      logSupervisor("control_job.succeeded", {
        run_id: runId,
        control_job_id: runningJob.id,
        control_job_type: runningJob.type
      });
    } catch (err) {
      const message = String(err?.message || err || "worker_control_job_failed");
      const code = (message.split(":")[0] || "WORKER_CONTROL_JOB_FAILED").toUpperCase();
      await markWorkerControlJobFailed({
        supabase,
        job: runningJob,
        errorCode: code,
        errorMessage: message
      });
      logSupervisor("control_job.failed", {
        run_id: runId,
        control_job_id: claimedJob.id,
        control_job_type: claimedJob.type,
        error_code: code,
        error_message: message
      });
      try {
        await touchWorkerHeartbeat({
          supabase,
          workerId: supervisorId,
          workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
          status: WORKER_HEARTBEAT_STATUS.DEGRADED,
          metadata: {
            publisher_loop_enabled: publisherLoopEnabled,
            failed_control_job_id: claimedJob.id,
            failed_control_job_type: claimedJob.type
          },
          lastError: message
        });
      } catch {
        // Best-effort heartbeat update only.
      }
      if (message.startsWith("singleton_guard_lost_to_")) {
        await stopSupervisor({
          supabase,
          reason: message,
          exitCode: 0
        });
        return;
      }
    }
  }
}

async function runPublisherLoopTick({ supabase }) {
  if (!publisherLoopEnabled) return;
  await runPublisherOnce({
    supabase,
    workerId: `${supervisorId}:publisher-loop`,
    dryRun: resolveDryRun()
  });
}

async function maybeCleanupStoppedHeartbeats({ supabase }) {
  const intervalMs = Number.isFinite(heartbeatCleanupIntervalMs)
    ? Math.max(heartbeatCleanupIntervalMs, 60_000)
    : 900_000;
  const nowMs = Date.now();
  if (nowMs - lastHeartbeatCleanupMs < intervalMs) return null;
  lastHeartbeatCleanupMs = nowMs;
  return cleanupStoppedWorkerHeartbeats({
    supabase,
    retentionDays: heartbeatRetentionDays
  });
}

async function renewSupervisorLease({ supabase }) {
  const result = await claimWorkerLease({
    supabase,
    lockKey: supervisorLockKey,
    holderId: supervisorId,
    leaseSeconds: supervisorLeaseSeconds,
    metadata: {
      worker_type: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
      hostname: os.hostname(),
      pid: process.pid
    }
  });
  return result;
}

async function stopSupervisor({
  supabase,
  reason = "supervisor_stopped",
  exitCode = 0
}) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  shouldExit = true;
  try {
    await touchWorkerHeartbeat({
      supabase,
      workerId: supervisorId,
      workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
      status: WORKER_HEARTBEAT_STATUS.STOPPED,
      metadata: { publisher_loop_enabled: publisherLoopEnabled },
      lastError: reason
    });
  } catch {
    // Best-effort shutdown heartbeat only.
  }
  try {
    await releaseWorkerLease({
      supabase,
      lockKey: supervisorLockKey,
      holderId: supervisorId
    });
  } catch {
    // Best-effort lease release only.
  }
  process.exit(exitCode);
}

async function runSupervisor() {
  loadWorkerEnv();
  const supabase = createSupabaseAdminClient();
  console.log(`Worker control supervisor started as ${supervisorId}`);
  const firstLease = await renewSupervisorLease({ supabase });
  if (!firstLease.acquired) {
    console.log(
      `Supervisor singleton already held by ${firstLease.holderId || "unknown"} until ${firstLease.leaseExpiresAt || "unknown"}; exiting.`
    );
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void stopSupervisor({ supabase, reason: "received_sigint", exitCode: 0 });
  });
  process.on("SIGTERM", () => {
    void stopSupervisor({ supabase, reason: "received_sigterm", exitCode: 0 });
  });

  await markSupersededSupervisorsStopped({ supabase });
  await touchWorkerHeartbeat({
    supabase,
    workerId: supervisorId,
    workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
    status: WORKER_HEARTBEAT_STATUS.STARTING,
    metadata: { publisher_loop_enabled: publisherLoopEnabled }
  });

  while (true) {
    if (shouldExit) break;
    try {
      const lease = await renewSupervisorLease({ supabase });
      if (!lease.acquired) {
        await stopSupervisor({
          supabase,
          reason: `singleton_guard_lost_to_${lease.holderId || "unknown"}`,
          exitCode: 0
        });
        return;
      }

      await touchWorkerHeartbeat({
        supabase,
        workerId: supervisorId,
        workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
        status: WORKER_HEARTBEAT_STATUS.IDLE,
        metadata: { publisher_loop_enabled: publisherLoopEnabled }
      });
      const claimed = await claimWorkerControlJobs({
        supabase,
        workerId: supervisorId
      });
      if (claimed.length) {
        await processClaimedControlJobs({ supabase, claimed });
      } else {
        await runPublisherLoopTick({ supabase });
      }
      await maybeCleanupStoppedHeartbeats({ supabase });
    } catch (err) {
      console.error("Worker control supervisor loop error:", err);
      try {
        await touchWorkerHeartbeat({
          supabase,
          workerId: supervisorId,
          workerType: WORKER_HEARTBEAT_TYPE.SUPERVISOR,
          status: WORKER_HEARTBEAT_STATUS.DEGRADED,
          metadata: { publisher_loop_enabled: publisherLoopEnabled },
          lastError: String(err?.message || err || "supervisor_loop_error")
        });
      } catch {
        // Best-effort heartbeat update only.
      }
    }
    await sleep(Math.max(controlPollMs, 1000));
  }
}

runSupervisor().catch(err => {
  console.error("Worker control supervisor failed:", err);
  process.exit(1);
});
