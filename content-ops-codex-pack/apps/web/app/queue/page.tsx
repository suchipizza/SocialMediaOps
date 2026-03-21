import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";
import {
  enqueuePublishJobsForPostId,
  retryFailedPublishJobsBulk,
  retryFailedPublishJobsForPostId
} from "../../lib/publish-jobs";
import { triggerRendererThenPublisher } from "../../lib/workers";

export const dynamic = "force-dynamic";

function formatScheduledAt(value: string | null | undefined, timezone?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const zone = String(timezone || "").trim() || "UTC";

  try {
    const localText = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .format(date)
      .replace(",", "");
    return `${localText} ${zone}`;
  } catch {
    const fallbackText = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .format(date)
      .replace(",", "");
    return `${fallbackText} UTC`;
  }
}

async function approvePost(formData: FormData) {
  "use server";
  const postId = String(formData.get("post_id") || "").trim();
  if (!postId) return;

  const supabase = createSupabaseServerClient();
  const { data: postForApproval, error: postLookupError } = await supabase
    .from("posts")
    .select("id,slide_count,job_id")
    .eq("id", postId)
    .maybeSingle();
  if (postLookupError || !postForApproval?.id) {
    redirect(`/queue?error=${encodeURIComponent(postLookupError?.message || "post_not_found")}`);
  }

  let templateId: string | null = null;
  if (postForApproval.job_id) {
    const { data: jobRow, error: jobLookupError } = await supabase
      .from("jobs")
      .select("template_id")
      .eq("id", postForApproval.job_id)
      .maybeSingle();
    if (jobLookupError) {
      redirect(`/queue?error=${encodeURIComponent(jobLookupError.message)}`);
    }
    templateId = jobRow?.template_id || null;
  }

  if (templateId) {
    const { data: template, error: templateError } = await supabase
      .from("templates")
      .select("id,manifest_json")
      .eq("id", templateId)
      .maybeSingle();
    if (templateError) {
      redirect(`/queue?error=${encodeURIComponent(templateError.message)}`);
    }

    const templateSlideCount = Number.parseInt(String(template?.manifest_json?.slide_count || ""), 10);
    const postSlideCount = Number.parseInt(String(postForApproval.slide_count || ""), 10);
    if (
      Number.isFinite(templateSlideCount) &&
      templateSlideCount > 0 &&
      Number.isFinite(postSlideCount) &&
      postSlideCount > 0 &&
      postSlideCount < templateSlideCount
    ) {
      const errorMessage = `Cannot approve post: template requires ${templateSlideCount} slides but post has ${postSlideCount}. Fix the source sheet/template first.`;
      redirect(`/queue?error=${encodeURIComponent(errorMessage)}`);
    }
  }

  const { error } = await supabase
    .from("posts")
    .update({ status: "APPROVED", error_code: null, error_message: null })
    .eq("id", postId);
  if (error) {
    redirect(`/queue?error=${encodeURIComponent(error.message)}`);
  }

  // Best-effort reset so re-approved posts are never blocked by stale retry timers.
  await supabase
    .from("posts")
    .update({
      render_attempt_count: 0,
      render_next_retry_at: null,
      render_last_attempt_at: null
    })
    .eq("id", postId);

  let triggerQuery = "";
  const triggerResult = await triggerRendererThenPublisher();
  if (triggerResult.triggered) {
    triggerQuery = "&workers_triggered=1";
  } else if (triggerResult.reason === "already_running") {
    triggerQuery = "&workers_triggered=0&workers_reason=already_running";
  } else if (triggerResult.reason === "disabled") {
    triggerQuery = "&workers_triggered=0&workers_reason=disabled";
  } else if (triggerResult.reason === "spawn_failed") {
    triggerQuery = `&workers_triggered=0&workers_reason=${encodeURIComponent(
      triggerResult.message || "spawn_failed"
    )}`;
  } else {
    triggerQuery = "&workers_triggered=0&workers_reason=unknown";
  }

  revalidatePath("/queue");
  redirect(`/queue?approved=1${triggerQuery}`);
}

async function enqueuePublishJobs(formData: FormData) {
  "use server";
  const postId = String(formData.get("post_id") || "").trim();
  if (!postId) return;

  let result: { created: number; reactivated: number; skipped: number };
  try {
    result = await enqueuePublishJobsForPostId(postId);
  } catch (error: any) {
    redirect(`/queue?error=${encodeURIComponent(error?.message || "publish_enqueue_failed")}`);
  }

  revalidatePath("/queue");
  redirect(
    `/queue?enqueued=${encodeURIComponent(String(result.created))}&reactivated=${encodeURIComponent(
      String(result.reactivated)
    )}&skipped=${encodeURIComponent(String(result.skipped))}`
  );
}

async function retryFailedPublishJobs(formData: FormData) {
  "use server";
  const postId = String(formData.get("post_id") || "").trim();
  if (!postId) return;

  let result: { retried: number; skipped: number };
  try {
    result = await retryFailedPublishJobsForPostId(postId);
  } catch (error: any) {
    redirect(`/queue?error=${encodeURIComponent(error?.message || "publish_retry_failed")}`);
  }

  revalidatePath("/queue");
  redirect(
    `/queue?retried=${encodeURIComponent(String(result.retried))}&retry_skipped=${encodeURIComponent(
      String(result.skipped)
    )}`
  );
}

async function retryAllFailedPublishJobs() {
  "use server";
  let result: { retried: number; posts: number; skipped: number };
  try {
    result = await retryFailedPublishJobsBulk({
      requestedBy: "queue_ui",
      source: "queue_bulk_requeue_button"
    });
  } catch (error: any) {
    redirect(`/queue?error=${encodeURIComponent(error?.message || "publish_bulk_retry_failed")}`);
  }

  revalidatePath("/queue");
  redirect(
    `/queue?bulk_retried=${encodeURIComponent(String(result.retried))}&bulk_posts=${encodeURIComponent(
      String(result.posts)
    )}`
  );
}

export default async function QueuePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const approved = Array.isArray(params.approved) ? params.approved[0] : params.approved;
  const enqueued = Array.isArray(params.enqueued) ? params.enqueued[0] : params.enqueued;
  const reactivated = Array.isArray(params.reactivated) ? params.reactivated[0] : params.reactivated;
  const skipped = Array.isArray(params.skipped) ? params.skipped[0] : params.skipped;
  const retried = Array.isArray(params.retried) ? params.retried[0] : params.retried;
  const retrySkipped = Array.isArray(params.retry_skipped) ? params.retry_skipped[0] : params.retry_skipped;
  const bulkRetried = Array.isArray(params.bulk_retried) ? params.bulk_retried[0] : params.bulk_retried;
  const bulkPosts = Array.isArray(params.bulk_posts) ? params.bulk_posts[0] : params.bulk_posts;
  const workersTriggered = Array.isArray(params.workers_triggered) ? params.workers_triggered[0] : params.workers_triggered;
  const workersReason = Array.isArray(params.workers_reason) ? params.workers_reason[0] : params.workers_reason;

  const supabase = createSupabaseServerClient();
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select(
      "id,status,ordering_index,scheduled_at,created_at,error_code,error_message,pillar_id,pillars(name),projects(timezone),publish_jobs(status,platform,last_error_code,last_error_message,updated_at,completed_at,attempt_count,max_attempts)"
    )
    .in("status", ["READY_FOR_REVIEW", "DRAFT", "APPROVED", "RENDERED", "FAILED"])
    .order("scheduled_at", { ascending: false, nullsFirst: false })
    .order("ordering_index", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(50);
  const { count: failedPublishJobsCount } = await supabase
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["FAILED_FINAL", "FAILED_RETRYABLE"]);

  const listError = postsError ? postsError.message : null;
  const items = (posts || []) as any[];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Queue</h1>
          <p className="page-subtitle">
            Review drafts, preview the carousel, and approve posts for scheduling.
          </p>
        </div>
      </div>

      {error || listError ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Queue error</h3>
          <p>{error || listError}</p>
        </div>
      ) : null}

      {approved ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Approved</h3>
          <p>
            Post moved to APPROVED.
            {workersTriggered === "1"
              ? " Renderer + publisher were triggered in background."
              : workersReason === "already_running"
                ? " Renderer/publisher already running in background."
                : workersReason === "disabled"
                  ? " Worker auto-trigger is disabled on this environment."
                  : workersReason
                    ? ` Worker trigger failed: ${workersReason}.`
                    : " Next step is rendering + scheduling."}
          </p>
        </div>
      ) : null}

      {enqueued ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Publish jobs enqueued</h3>
          <p>
            Created {enqueued} publish job(s)
            {typeof reactivated !== "undefined" ? `, reactivated ${reactivated}` : ""}
            {typeof skipped !== "undefined" ? `, skipped ${skipped}` : ""}.
          </p>
        </div>
      ) : null}

      {retried ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Publish jobs retried</h3>
          <p>
            Requeued {retried} failed publish job(s)
            {typeof retrySkipped !== "undefined" ? `, skipped ${retrySkipped}` : ""}.
          </p>
        </div>
      ) : null}

      {bulkRetried ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Bulk retry complete</h3>
          <p>
            Requeued {bulkRetried} failed publish job(s) across {bulkPosts || "0"} post(s). Audit events were logged.
          </p>
        </div>
      ) : null}

      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap"
          }}
        >
          <h3 style={{ margin: 0 }}>Publish operations</h3>
          <form action={retryAllFailedPublishJobs}>
            <button type="submit" className="secondary" disabled={!Number(failedPublishJobsCount || 0)}>
              Requeue failed publish jobs ({failedPublishJobsCount || 0})
            </button>
          </form>
        </div>
        <p style={{ marginTop: 10 }}>
          Resets failed publish jobs to <strong>PENDING</strong>, clears provider errors, and keeps each post’s
          scheduled timestamp.
        </p>
      </div>

      {!items.length ? (
        <div className="empty">No drafts awaiting review yet. Ingest a job from Google Sheets first.</div>
      ) : (
        <div className="card">
          <h3>Queue posts</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Pillar</th>
                <th>Status</th>
                <th>Order</th>
                <th>Scheduled at</th>
                <th>Preview</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map(post => {
                const projectTimezone = Array.isArray(post.projects)
                  ? post.projects[0]?.timezone
                  : post.projects?.timezone;
                const publishJobs = Array.isArray(post.publish_jobs) ? post.publish_jobs : [];
                const publishStatuses = publishJobs.map((job: any) => String(job?.status || ""));
                const hasFailedPublishJobs = publishJobs.some((job: any) =>
                  ["FAILED_FINAL", "FAILED_RETRYABLE"].includes(String(job?.status || ""))
                );
                const latestFailedPublishJob = [...publishJobs]
                  .filter((job: any) => ["FAILED_FINAL", "FAILED_RETRYABLE"].includes(String(job?.status || "")))
                  .sort((a: any, b: any) => {
                    const timeA = Date.parse(String(a?.completed_at || a?.updated_at || "")) || 0;
                    const timeB = Date.parse(String(b?.completed_at || b?.updated_at || "")) || 0;
                    return timeB - timeA;
                  })[0];
                const hasPublishedPublishJobs = publishStatuses.includes("PUBLISHED");
                const hasCancelledPublishJobs = publishStatuses.includes("CANCELLED");
                const hasPendingOrSendingPublishJobs = publishStatuses.some(status =>
                  ["PENDING", "SENDING", "FAILED_RETRYABLE"].includes(status)
                );

                return (
                  <tr key={post.id}>
                    <td>
                      {(Array.isArray(post.pillars) ? post.pillars[0]?.name : post.pillars?.name) || post.pillar_id}
                    </td>
                    <td>{post.status}</td>
                    <td>{post.ordering_index}</td>
                    <td>{formatScheduledAt(post.scheduled_at, projectTimezone)}</td>
                    <td>
                      <a className="chip" href={`/queue/${post.id}`}>
                        View carousel
                      </a>
                    </td>
                    <td>
                      {post.status === "READY_FOR_REVIEW" || post.status === "DRAFT" ? (
                        <form action={approvePost}>
                          <input type="hidden" name="post_id" value={post.id} />
                          <button type="submit">Approve</button>
                        </form>
                      ) : post.status === "FAILED" ? (
                        <div style={{ maxWidth: 360 }}>
                          <form action={approvePost}>
                            <input type="hidden" name="post_id" value={post.id} />
                            <button type="submit">Re-approve</button>
                          </form>
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              lineHeight: 1.35,
                              color: "rgba(77, 90, 111, 0.95)"
                            }}
                          >
                            <div>
                              Render failed: <strong>{String(post.error_code || "unknown_error")}</strong>
                            </div>
                            <div>{String(post.error_message || "No renderer message.").slice(0, 180)}</div>
                          </div>
                        </div>
                      ) : post.status === "RENDERED" && hasFailedPublishJobs ? (
                        <>
                          <form action={retryFailedPublishJobs}>
                            <input type="hidden" name="post_id" value={post.id} />
                            <button type="submit">Retry failed publish</button>
                          </form>
                          <div
                            style={{
                              marginTop: 6,
                              maxWidth: 360,
                              fontSize: 12,
                              lineHeight: 1.35,
                              color: "rgba(77, 90, 111, 0.95)"
                            }}
                          >
                            <div>
                              Last failure:{" "}
                              <strong>{String(latestFailedPublishJob?.last_error_code || "unknown_error")}</strong>
                              {latestFailedPublishJob?.platform
                                ? ` (${String(latestFailedPublishJob.platform)})`
                                : ""}
                            </div>
                            <div>
                              {String(
                                latestFailedPublishJob?.last_error_message || "No provider message."
                              ).slice(0, 180)}
                            </div>
                            <div>
                              Attempt {Number(latestFailedPublishJob?.attempt_count || 0)} /{" "}
                              {Number(latestFailedPublishJob?.max_attempts || 0)}
                            </div>
                          </div>
                        </>
                      ) : post.status === "RENDERED" && hasPublishedPublishJobs && !hasPendingOrSendingPublishJobs ? (
                        <span className="chip">Published</span>
                      ) : post.status === "RENDERED" && hasPendingOrSendingPublishJobs ? (
                        <span className="chip">Publishing queued</span>
                      ) : post.status === "RENDERED" &&
                        hasCancelledPublishJobs &&
                        !hasPendingOrSendingPublishJobs &&
                        !hasPublishedPublishJobs ? (
                        <form action={enqueuePublishJobs}>
                          <input type="hidden" name="post_id" value={post.id} />
                          <button type="submit">Requeue publish</button>
                        </form>
                      ) : post.status === "RENDERED" ? (
                        <form action={enqueuePublishJobs}>
                          <input type="hidden" name="post_id" value={post.id} />
                          <button type="submit">Ready to publish</button>
                        </form>
                      ) : (
                        <span className="chip">Waiting render</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
