import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";

async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const timezone = String(formData.get("timezone") || "Europe/Zurich").trim();
  const slotTimes = String(formData.get("slot_times") || "09:00,13:00,18:00")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const platformsEnabled = {
    instagram: formData.get("platform_instagram") === "on",
    tiktok: formData.get("platform_tiktok") === "on"
  };

  if (!name) {
    return;
  }

  const supabase = createSupabaseServerClient();
  await supabase.from("projects").insert({
    name,
    description: description || null,
    timezone: timezone || "Europe/Zurich",
    slot_times: slotTimes.length ? slotTimes : ["09:00", "13:00", "18:00"],
    platforms_enabled: platformsEnabled
  });

  revalidatePath("/projects");
}

async function deleteProject(formData: FormData) {
  "use server";
  const projectId = String(formData.get("project_id") || "").trim();
  if (!projectId) return;

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) {
    redirect(`/projects?error=${encodeURIComponent(error.message || "project_delete_failed")}`);
  }

  revalidatePath("/projects");
  redirect("/projects?deleted=1");
}

export default async function ProjectsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const deleted = Array.isArray(params.deleted) ? params.deleted[0] : params.deleted;
  const supabase = createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="page-subtitle">
            Each project bundles platforms, pillars, schedules, and publishing credentials.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Project update failed</h3>
          <p>{error}</p>
        </div>
      ) : null}

      {deleted ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Project deleted</h3>
          <p>All related jobs, posts, pillars, and events were removed.</p>
        </div>
      ) : null}

      <div className="card-grid">
        <div className="card">
          <h3>Create a project</h3>
          <form className="form" action={createProject}>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" placeholder="Morning carousel sprint" required />
            </div>
            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={3} />
            </div>
            <div className="field">
              <label htmlFor="timezone">Timezone</label>
              <input id="timezone" name="timezone" defaultValue="Europe/Zurich" />
            </div>
            <div className="field">
              <label htmlFor="slot_times">Daily slots (comma separated)</label>
              <input id="slot_times" name="slot_times" defaultValue="09:00,13:00,18:00" />
            </div>
            <div className="field">
              <label>Platforms</label>
              <label>
                <input type="checkbox" name="platform_instagram" defaultChecked /> Instagram
              </label>
              <label>
                <input type="checkbox" name="platform_tiktok" /> TikTok
              </label>
            </div>
            <button type="submit">Create project</button>
          </form>
        </div>

        <div className="card">
          <h3>Active projects</h3>
          {!projects?.length ? (
            <div className="empty">No projects yet. Create your first above.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Timezone</th>
                  <th>Slots</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map(project => (
                  <tr key={project.id}>
                    <td>{project.name}</td>
                    <td>{project.timezone}</td>
                    <td>{(project.slot_times || []).join(", ")}</td>
                    <td>
                      <form action={deleteProject}>
                        <input type="hidden" name="project_id" value={project.id} />
                        <button type="submit" className="secondary">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
