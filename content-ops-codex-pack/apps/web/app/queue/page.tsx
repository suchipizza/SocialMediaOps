import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";

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
  revalidatePath("/queue");
  redirect("/queue?approved=1");
}

export default async function QueuePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const approved = Array.isArray(params.approved) ? params.approved[0] : params.approved;

  const supabase = createSupabaseServerClient();
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("id,status,ordering_index,created_at,pillar_id,pillars(name)")
    .in("status", ["READY_FOR_REVIEW", "DRAFT"])
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
          <p>Post moved to APPROVED. Next step is rendering + scheduling.</p>
        </div>
      ) : null}

      {!items.length ? (
        <div className="empty">No drafts awaiting review yet. Ingest a job from Google Sheets first.</div>
      ) : (
        <div className="card">
          <h3>Needs review</h3>
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
              {items.map(post => (
                <tr key={post.id}>
                  <td>{(Array.isArray(post.pillars) ? post.pillars[0]?.name : post.pillars?.name) || post.pillar_id}</td>
                  <td>{post.status}</td>
                  <td>{post.ordering_index}</td>
                  <td>
                    <a className="chip" href={`/queue/${post.id}`}>
                      View carousel
                    </a>
                  </td>
                  <td>
                    <form action={approvePost}>
                      <input type="hidden" name="post_id" value={post.id} />
                      <button type="submit">Approve</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
