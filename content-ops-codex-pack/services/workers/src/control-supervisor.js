import os from "node:os";
import {
  claimWorkerControlJobs,
  CONTROL_JOB_TYPES,
  markWorkerControlJobFailed,
  markWorkerControlJobRunning,
  markWorkerControlJobSucceeded
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
const heartbeatCleanupIntervalMs = Number.parseInt(process.env.WORKER_HEARTBEAT_CLEANUP_INTERVAL_MS || "900000", 10);
const heartbeatRetentionDays = Number.parseInt(process.env.WORKER_HEARTBEAT_RETENTION_DAYS || "7", 10);
let publisherLoopEnabled =
  String(process.env.WORKER_PUBLISHER_LOOP_ENABLED || "false").toLowerCase() === "true";
let lastHeartbeatCleanupMs = 0;
let shouldExit = false;
let shutdownInProgress = false;

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

async function runControlJob({ supabase, controlJob }) {
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_RENDERER_DRAIN) {
    return runRendererUntilDrained({ supabase });
  }
  if (controlJob.type === CONTROL_JOB_TYPES.RUN_PUBLISHER_ONCE) {
    return runPublisherOnce({
      supabase,
      workerId: `${supervisorId}:publisher-once`,
      dryRun: resolveDryRun()
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
    try {
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
      const runningJob = await markWorkerControlJobRunning({
        supabase,
        job: claimedJob,
        workerId: supervisorId
      });
      const result = await runControlJob({ supabase, controlJob: runningJob });
      await markWorkerControlJobSucceeded({
        supabase,
        jobId: runningJob.id,
        result:
          result && typeof result === "object"
            ? { ...result, supervisor_id: supervisorId }
            : { value: result, supervisor_id: supervisorId }
      });
    } catch (err) {
      const message = String(err?.message || err || "worker_control_job_failed");
      const code = (message.split(":")[0] || "WORKER_CONTROL_JOB_FAILED").toUpperCase();
      await markWorkerControlJobFailed({
        supabase,
        job: claimedJob,
        errorCode: code,
        errorMessage: message
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
