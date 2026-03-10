import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";

export const dynamic = "force-dynamic";

const ALLOWED_CONTROL_TYPES = new Set([
  "RUN_RENDERER_DRAIN",
  "RUN_PUBLISHER_ONCE",
  "RUN_PUBLISHER_LOOP_START",
  "RUN_PUBLISHER_LOOP_STOP"
]);
const ACTIVE_CONTROL_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "FAILED_RETRYABLE"];
const HEARTBEAT_STALE_SECONDS = Number.parseInt(process.env.WORKER_HEARTBEAT_STALE_SECONDS || "90", 10);
const HEARTBEAT_RETENTION_DAYS = Number.parseInt(process.env.WORKER_HEARTBEAT_RETENTION_DAYS || "7", 10);
const ACTIVE_HEARTBEAT_STATUSES = ["STARTING", "IDLE", "RUNNING", "DEGRADED"];

function controlTypeLabel(type: string) {
  if (type === "RUN_RENDERER_DRAIN") return "Renderer drain";
  if (type === "RUN_PUBLISHER_ONCE") return "Publisher once";
  if (type === "RUN_PUBLISHER_LOOP_START") return "Publisher loop start";
  if (type === "RUN_PUBLISHER_LOOP_STOP") return "Publisher loop stop";
  return type;
}

function defaultPriorityForType(type: string) {
  if (type === "RUN_RENDERER_DRAIN") return 100;
  if (type === "RUN_PUBLISHER_ONCE") return 50;
  if (type === "RUN_PUBLISHER_LOOP_START") return 30;
  if (type === "RUN_PUBLISHER_LOOP_STOP") return 30;
  return 0;
}

function asText(value: unknown, fallback = "—") {
  if (value === null || typeof value === "undefined") return fallback;
  const stringValue = String(value).trim();
  return stringValue || fallback;
}

function formatIso(value: unknown) {
  const text = asText(value, "");
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return asText(value);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function formatAgeMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return `${totalHr}h ${remMin}m`;
}

async function enqueueControlJob(formData: FormData) {
  "use server";
  const type = String(formData.get("type") || "").trim();
  const scopeKey = String(formData.get("scope_key") || "global").trim() || "global";
  if (!ALLOWED_CONTROL_TYPES.has(type)) {
    redirect(`/operations?error=${encodeURIComponent("Invalid worker control action.")}`);
  }

  const supabase = createSupabaseServerClient();
  const { data: activeExisting, error: activeLookupError } = await supabase
    .from("worker_control_jobs")
    .select("id")
    .eq("type", type)
    .eq("scope_key", scopeKey)
    .in("status", ACTIVE_CONTROL_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeLookupError) {
    redirect(`/operations?error=${encodeURIComponent(activeLookupError.message || "control_job_lookup_failed")}`);
  }

  if (activeExisting?.id) {
    revalidatePath("/operations");
    redirect(`/operations?already_running=1&type=${encodeURIComponent(type)}`);
  }

  const priority = defaultPriorityForType(type);
  const idempotencyKey = `${type}:${scopeKey}:${Date.now()}:${randomUUID()}`;
  const payload = {
    source: "operations_ui",
    requested_at: new Date().toISOString(),
    trigger: "manual_operations"
  };

  const { error: insertError } = await supabase.from("worker_control_jobs").insert({
    type,
    status: "PENDING",
    priority,
    payload,
    idempotency_key: idempotencyKey,
    scope_key: scopeKey,
    requested_by: "operations_ui"
  });

  if (insertError) {
    const duplicate = insertError.code === "23505" || String(insertError.message || "").includes("active_scope_idx");
    if (duplicate) {
      revalidatePath("/operations");
      redirect(`/operations?already_running=1&type=${encodeURIComponent(type)}`);
    }
    redirect(`/operations?error=${encodeURIComponent(insertError.message || "control_job_enqueue_failed")}`);
  }

  revalidatePath("/operations");
  redirect(`/operations?queued=1&type=${encodeURIComponent(type)}`);
}

async function cleanupHeartbeatHistory() {
  "use server";
  const supabase = createSupabaseServerClient();
  const retentionDays = Number.isFinite(HEARTBEAT_RETENTION_DAYS) ? Math.max(1, HEARTBEAT_RETENTION_DAYS) : 7;
  const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("worker_heartbeats")
    .delete({ count: "exact" })
    .eq("status", "STOPPED")
    .lt("last_seen_at", cutoffIso);

  if (error) {
    redirect(`/operations?error=${encodeURIComponent(error.message || "heartbeat_cleanup_failed")}`);
  }

  revalidatePath("/operations");
  redirect(`/operations?cleaned=${Math.max(count || 0, 0)}&retention_days=${retentionDays}`);
}

export default async function OperationsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const queued = Array.isArray(params.queued) ? params.queued[0] : params.queued;
  const alreadyRunning = Array.isArray(params.already_running) ? params.already_running[0] : params.already_running;
  const queuedType = Array.isArray(params.type) ? params.type[0] : params.type;
  const cleaned = Array.isArray(params.cleaned) ? params.cleaned[0] : params.cleaned;
  const retentionDaysParam = Array.isArray(params.retention_days) ? params.retention_days[0] : params.retention_days;
  const showStopped = (Array.isArray(params.show_stopped) ? params.show_stopped[0] : params.show_stopped) === "1";

  const supabase = createSupabaseServerClient();
  const { data: activeJobs, error: activeError } = await supabase
    .from("worker_control_jobs")
    .select("id,type,status,scope_key,priority,attempt_count,claimed_by,claimed_at,started_at,next_retry_at,created_at")
    .in("status", ACTIVE_CONTROL_STATUSES)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: recentJobs, error: historyError } = await supabase
    .from("worker_control_jobs")
    .select(
      "id,type,status,scope_key,priority,attempt_count,max_attempts,requested_by,claimed_by,created_at,started_at,completed_at,error_code,error_message,result_json"
    )
    .order("created_at", { ascending: false })
    .limit(80);

  let heartbeatsQuery = supabase
    .from("worker_heartbeats")
    .select("worker_id,worker_type,status,hostname,pid,last_seen_at,started_at,last_error,metadata,updated_at")
    .order("last_seen_at", { ascending: false })
    .limit(showStopped ? 80 : 30);
  if (!showStopped) {
    heartbeatsQuery = heartbeatsQuery.in("status", ACTIVE_HEARTBEAT_STATUSES);
  }
  const { data: heartbeats, error: heartbeatsError } = await heartbeatsQuery;

  const listError = activeError?.message || historyError?.message || heartbeatsError?.message || null;
  const nowMs = Date.now();
  const staleThresholdMs = Math.max(HEARTBEAT_STALE_SECONDS, 1) * 1000;
  const heartbeatRows = (heartbeats || []).map((row: any) => {
    const lastSeenMs = row?.last_seen_at ? new Date(row.last_seen_at).getTime() : Number.NaN;
    const ageMs = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : Number.NaN;
    const isActiveStatus = ACTIVE_HEARTBEAT_STATUSES.includes(String(row?.status || ""));
    const isStale = isActiveStatus ? (Number.isFinite(ageMs) ? ageMs > staleThresholdMs : true) : false;
    return { ...row, ageMs, isStale };
  });
  const staleCount = heartbeatRows.filter((row: any) => row.isStale).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Operations</h1>
          <p className="page-subtitle">Trigger renderer/publisher control jobs and inspect worker control queue history.</p>
        </div>
      </div>

      {error || listError ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Operations error</h3>
          <p>{error || listError}</p>
        </div>
      ) : null}

      {queued ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Control job queued</h3>
          <p>{controlTypeLabel(String(queuedType || "worker action"))} was enqueued successfully.</p>
        </div>
      ) : null}

      {alreadyRunning ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Already running</h3>
          <p>An active {controlTypeLabel(String(queuedType || "worker action"))} control job already exists.</p>
        </div>
      ) : null}

      {typeof cleaned !== "undefined" ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Heartbeat cleanup completed</h3>
          <p>
            Deleted {asText(cleaned, "0")} STOPPED heartbeat row(s) older than {asText(retentionDaysParam, String(HEARTBEAT_RETENTION_DAYS))} day(s).
          </p>
        </div>
      ) : null}

      <div className="card" style={{ borderColor: staleCount > 0 ? "rgba(240, 108, 0, 0.5)" : "rgba(34, 140, 34, 0.4)" }}>
        <h3>Worker freshness</h3>
        <p>
          {heartbeatRows.length} worker heartbeat row(s) shown ({showStopped ? "active + stopped history" : "active only"}), {staleCount} stale
          using threshold {HEARTBEAT_STALE_SECONDS}s.
        </p>
        <form action={cleanupHeartbeatHistory}>
          <button type="submit" className="secondary">
            Cleanup STOPPED older than {Math.max(HEARTBEAT_RETENTION_DAYS, 1)}d
          </button>
        </form>
      </div>

      <div className="card-grid">
        <div className="card">
          <h3>Run now</h3>
          <div className="form">
            <form action={enqueueControlJob}>
              <input type="hidden" name="scope_key" value="global" />
              <input type="hidden" name="type" value="RUN_RENDERER_DRAIN" />
              <button type="submit">Run renderer now</button>
            </form>
            <form action={enqueueControlJob}>
              <input type="hidden" name="scope_key" value="global" />
              <input type="hidden" name="type" value="RUN_PUBLISHER_ONCE" />
              <button type="submit">Run publisher now</button>
            </form>
            <form action={enqueueControlJob}>
              <input type="hidden" name="scope_key" value="global" />
              <input type="hidden" name="type" value="RUN_PUBLISHER_LOOP_START" />
              <button type="submit" className="secondary">
                Start publisher loop
              </button>
            </form>
            <form action={enqueueControlJob}>
              <input type="hidden" name="scope_key" value="global" />
              <input type="hidden" name="type" value="RUN_PUBLISHER_LOOP_STOP" />
              <button type="submit" className="secondary">
                Stop publisher loop
              </button>
            </form>
          </div>
        </div>

        <div className="card">
          <h3>Active control jobs</h3>
          {!activeJobs?.length ? (
            <div className="empty">No active control jobs.</div>
          ) : (
            <div className="table-scroll">
              <table className="table table-wide">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Scope</th>
                    <th>Priority</th>
                    <th>Attempts</th>
                    <th>Claimed by</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {(activeJobs || []).map((job: any) => (
                    <tr key={job.id}>
                      <td>{controlTypeLabel(asText(job.type, ""))}</td>
                      <td>
                        <span className="chip">{asText(job.status, "")}</span>
                      </td>
                      <td>{asText(job.scope_key)}</td>
                      <td>{asText(job.priority)}</td>
                      <td>{`${asText(job.attempt_count, "0")}`}</td>
                      <td>{asText(job.claimed_by)}</td>
                      <td>{asText(job.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Worker heartbeats</h3>
        <p>
          {showStopped ? (
            <a href="/operations">Show active only</a>
          ) : (
            <a href="/operations?show_stopped=1">Show stopped history</a>
          )}
        </p>
        {!heartbeatRows.length ? (
          <div className="empty">No heartbeat rows yet. Start supervisor to emit heartbeats.</div>
        ) : (
          <div className="table-scroll">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Freshness</th>
                  <th>Last seen</th>
                  <th>Started</th>
                  <th>Host/PID</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {heartbeatRows.map((row: any) => (
                  <tr key={row.worker_id}>
                    <td>{asText(row.worker_id)}</td>
                    <td>{asText(row.worker_type)}</td>
                    <td>
                      <span className="chip">{asText(row.status)}</span>
                    </td>
                    <td>
                      {String(row.status || "") === "STOPPED" ? (
                        <span className="chip" style={{ background: "#f3f3f3", color: "#6a6a6a" }}>
                          —
                        </span>
                      ) : row.isStale ? (
                        <span className="chip" style={{ background: "#ffe6cf", color: "#a94400" }}>
                          Stale ({formatAgeMs(row.ageMs)})
                        </span>
                      ) : (
                        <span className="chip" style={{ background: "#e8f6e8", color: "#1f6e1f" }}>
                          Fresh ({formatAgeMs(row.ageMs)})
                        </span>
                      )}
                    </td>
                    <td>{formatIso(row.last_seen_at)}</td>
                    <td>{formatIso(row.started_at)}</td>
                    <td>{`${asText(row.hostname)} / ${asText(row.pid)}`}</td>
                    <td>{asText(row.last_error)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Recent control-job history</h3>
        {!recentJobs?.length ? (
          <div className="empty">No control-job history yet.</div>
        ) : (
          <div className="table-scroll">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Scope</th>
                  <th>Attempts</th>
                  <th>Requester</th>
                  <th>Claimed by</th>
                  <th>Completed</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {(recentJobs || []).map((job: any) => (
                  <tr key={job.id}>
                    <td>{asText(job.created_at)}</td>
                    <td>{controlTypeLabel(asText(job.type, ""))}</td>
                    <td>
                      <span className="chip">{asText(job.status, "")}</span>
                    </td>
                    <td>{asText(job.scope_key)}</td>
                    <td>{`${asText(job.attempt_count, "0")}/${asText(job.max_attempts, "0")}`}</td>
                    <td>{asText(job.requested_by)}</td>
                    <td>{asText(job.claimed_by)}</td>
                    <td>{asText(job.completed_at)}</td>
                    <td>{asText(job.error_code) === "—" ? asText(job.error_message) : `${asText(job.error_code)} ${asText(job.error_message)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
