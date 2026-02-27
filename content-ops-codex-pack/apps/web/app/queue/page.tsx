import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";
import { enqueuePublishJobsForPostId, retryFailedPublishJobsForPostId } from "../../lib/publish-jobs";
import { triggerRendererThenPublisher } from "../../lib/workers";

export const dynamic = "force-dynamic";

async function approvePost(formData: FormData) {
  "use server";
  const postId = String(formData.get("post_id") || "").trim();
  if (!postId) return;

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from("posts").update({ status: "APPROVED" }).eq("id", postId);
  if (error) {
    redirect(`/queue?error=${encodeURIComponent(error.message)}`);
  }

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

  let result: { created: number; skipped: number };
  try {
    result = await enqueuePublishJobsForPostId(postId);
  } catch (error: any) {
    redirect(`/queue?error=${encodeURIComponent(error?.message || "publish_enqueue_failed")}`);
  }

  revalidatePath("/queue");
  redirect(
    `/queue?enqueued=${encodeURIComponent(String(result.created))}&skipped=${encodeURIComponent(
      String(result.skipped)
    )}`
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

export default async function QueuePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const approved = Array.isArray(params.approved) ? params.approved[0] : params.approved;
  const enqueued = Array.isArray(params.enqueued) ? params.enqueued[0] : params.enqueued;
  const skipped = Array.isArray(params.skipped) ? params.skipped[0] : params.skipped;
  const retried = Array.isArray(params.retried) ? params.retried[0] : params.retried;
  const retrySkipped = Array.isArray(params.retry_skipped) ? params.retry_skipped[0] : params.retry_skipped;
  const workersTriggered = Array.isArray(params.workers_triggered) ? params.workers_triggered[0] : params.workers_triggered;
  const workersReason = Array.isArray(params.workers_reason) ? params.workers_reason[0] : params.workers_reason;

  const supabase = createSupabaseServerClient();
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("id,status,ordering_index,created_at,pillar_id,pillars(name),publish_jobs(status,platform)")
    .in("status", ["READY_FOR_REVIEW", "DRAFT", "APPROVED", "RENDERED"])
    .order("created_at", { ascending: false })
    .limit(50);

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
                <th>Preview</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map(post => {
                const publishJobs = Array.isArray(post.publish_jobs) ? post.publish_jobs : [];
                const publishStatuses = publishJobs.map((job: any) => String(job?.status || ""));
                const hasFailedPublishJobs = publishJobs.some((job: any) =>
                  ["FAILED_FINAL", "FAILED_RETRYABLE"].includes(String(job?.status || ""))
                );
                const hasPublishedPublishJobs = publishStatuses.includes("PUBLISHED");
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
                      ) : post.status === "RENDERED" && hasFailedPublishJobs ? (
                        <form action={retryFailedPublishJobs}>
                          <input type="hidden" name="post_id" value={post.id} />
                          <button type="submit">Retry failed publish</button>
                        </form>
                      ) : post.status === "RENDERED" && hasPublishedPublishJobs && !hasPendingOrSendingPublishJobs ? (
                        <span className="chip">Published</span>
                      ) : post.status === "RENDERED" && hasPendingOrSendingPublishJobs ? (
                        <span className="chip">Publishing queued</span>
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
