import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

type TriggerResult =
  | { triggered: true; reason: "started" }
  | { triggered: false; reason: "already_running" | "disabled" | "spawn_failed"; message?: string };

const LOCK_MAX_AGE_MS = Number.parseInt(process.env.UI_WORKER_TRIGGER_LOCK_MAX_AGE_MS || "900000", 10);

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
  const explicit = String(process.env.ENABLE_UI_WORKER_TRIGGER || "").trim().toLowerCase();
  if (explicit) return explicit === "1" || explicit === "true" || explicit === "yes" || explicit === "on";
  return !Boolean(process.env.VERCEL);
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

export async function triggerRendererThenPublisher(): Promise<TriggerResult> {
  if (!isUiWorkerTriggerEnabled()) {
    return { triggered: false, reason: "disabled" };
  }

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
