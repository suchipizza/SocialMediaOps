import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "./supabase";

type TriggerResult =
  | { triggered: true; reason: "started" }
  | { triggered: false; reason: "already_running" | "disabled" | "spawn_failed"; message?: string };

const LOCK_MAX_AGE_MS = Number.parseInt(process.env.UI_WORKER_TRIGGER_LOCK_MAX_AGE_MS || "900000", 10);
const ACTIVE_CONTROL_JOB_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "FAILED_RETRYABLE"] as const;

function parseTruthy(value: string | undefined, fallback: boolean) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function isUiWorkerTriggerEnabled() {
  const explicit = String(process.env.ENABLE_UI_WORKER_TRIGGER || "").trim();
  if (explicit) return parseTruthy(explicit, false);
  return !Boolean(process.env.VERCEL);
}

function useWorkerControlQueue() {
  const mode = String(process.env.UI_WORKER_TRIGGER_MODE || "").trim().toLowerCase();
  if (mode === "queue") return true;
  if (mode === "spawn") return false;
  return parseTruthy(process.env.ENABLE_WORKER_CONTROL_QUEUE, true);
}

function allowSpawnFallback() {
  return parseTruthy(process.env.UI_WORKER_TRIGGER_SPAWN_FALLBACK, true);
}

async function acquireLock(lockPath: string) {
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ started_at: new Date().toISOString(), pid: process.pid }));
    await handle.close();
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;

    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) return false;
    const ageMs = Date.now() - stat.mtimeMs;
    if (Number.isFinite(ageMs) && ageMs > LOCK_MAX_AGE_MS) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      const staleHandle = await fs.open(lockPath, "wx");
      await staleHandle.writeFile(JSON.stringify({ started_at: new Date().toISOString(), pid: process.pid }));
      await staleHandle.close();
      return true;
    }
    return false;
  }
}

async function findActiveControlJob(supabase: ReturnType<typeof createSupabaseServerClient>, type: string, scopeKey: string) {
  const { data } = await supabase
    .from("worker_control_jobs")
    .select("id")
    .eq("type", type)
    .eq("scope_key", scopeKey)
    .in("status", [...ACTIVE_CONTROL_JOB_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ? data : null;
}

async function enqueueControlJob(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  {
    type,
    scopeKey,
    priority,
    payload
  }: {
    type: "RUN_RENDERER_DRAIN" | "RUN_PUBLISHER_ONCE";
    scopeKey: string;
    priority: number;
    payload: Record<string, unknown>;
  }
) {
  const idempotencyKey = `${type}:${scopeKey}:${Date.now()}:${randomUUID()}`;
  const { data, error } = await supabase
    .from("worker_control_jobs")
    .insert({
      type,
      status: "PENDING",
      priority,
      payload,
      idempotency_key: idempotencyKey,
      scope_key: scopeKey,
      requested_by: "web_ui"
    })
    .select("id")
    .maybeSingle();

  if (!error && data?.id) {
    return { created: true as const };
  }

  const message = String(error?.message || "");
  const duplicateKey = error?.code === "23505";
  if (duplicateKey || message.includes("worker_control_jobs_active_scope_idx")) {
    const active = await findActiveControlJob(supabase, type, scopeKey);
    if (active?.id) return { created: false as const, reason: "already_running" as const };
  }

  throw new Error(message || "worker_control_enqueue_failed");
}

async function triggerViaControlQueue(): Promise<TriggerResult> {
  const supabase = createSupabaseServerClient();
  const scopeKey = "global";
  const payload = {
    source: "web_ui",
    requested_at: new Date().toISOString(),
    trigger: "approve_post"
  };

  const renderer = await enqueueControlJob(supabase, {
    type: "RUN_RENDERER_DRAIN",
    scopeKey,
    priority: 100,
    payload
  });
  const publisher = await enqueueControlJob(supabase, {
    type: "RUN_PUBLISHER_ONCE",
    scopeKey,
    priority: 50,
    payload
  });

  if (renderer.created || publisher.created) {
    return { triggered: true, reason: "started" };
  }
  return { triggered: false, reason: "already_running" };
}

async function triggerViaSpawnLock(): Promise<TriggerResult> {
  const repoRoot = getRepoRoot();
  const workersDir = path.join(repoRoot, "services", "workers");
  const lockDir = path.join(repoRoot, ".cache", "worker-runs");
  const lockPath = path.join(lockDir, "render-publish.lock");

  await fs.mkdir(lockDir, { recursive: true });
  const lockAcquired = await acquireLock(lockPath);
  if (!lockAcquired) {
    return { triggered: false, reason: "already_running" };
  }

  const command = `
set -e
cleanup() {
  rm -f ${shellQuote(lockPath)}
}
trap cleanup EXIT INT TERM
node ./src/renderer.js
node ./src/publisher.js
`;

  const env = {
    ...process.env,
    DOTENV_PATH: process.env.DOTENV_PATH || path.join(repoRoot, ".env")
  };

  try {
    const child = spawn("sh", ["-lc", command], {
      cwd: workersDir,
      env,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { triggered: true, reason: "started" };
  } catch (error: any) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return {
      triggered: false,
      reason: "spawn_failed",
      message: String(error?.message || error || "worker_spawn_failed")
    };
  }
}

export async function triggerRendererThenPublisher(): Promise<TriggerResult> {
  if (!isUiWorkerTriggerEnabled()) {
    return { triggered: false, reason: "disabled" };
  }

  if (useWorkerControlQueue()) {
    try {
      return await triggerViaControlQueue();
    } catch (error: any) {
      if (!allowSpawnFallback()) {
        return {
          triggered: false,
          reason: "spawn_failed",
          message: String(error?.message || error || "worker_control_queue_failed")
        };
      }
    }
  }

  return triggerViaSpawnLock();
}
