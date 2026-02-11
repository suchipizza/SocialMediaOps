import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import path from "node:path";
import fs from "node:fs/promises";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "../../lib/supabase";
import { createTemplateFromZip } from "../../lib/templates";

function normalizeErrorMessage(input: unknown) {
  const raw = String(input || "upload_failed");
  if (raw.startsWith("storage_upload_failed:")) {
    return `Storage upload failed. Check the bucket exists and is writable. (${raw.replace(
      "storage_upload_failed:",
      ""
    )})`;
  }
  if (raw.startsWith("db_insert_failed:")) {
    return `Database insert failed. Did you run the migration? (${raw.replace("db_insert_failed:", "")})`;
  }
  if (raw === "manifest_missing") return "manifest.json not found in the zip (expected a template pack format).";
  if (raw === "manifest_invalid_json") return "manifest.json is not valid JSON.";
  if (raw.startsWith("manifest_invalid_schema:")) {
    return `manifest.json schema error: ${raw.replace("manifest_invalid_schema:", "")}`;
  }
  if (raw === "template_format_unknown") return "Template format not recognized (expected Format A, B, or C).";
  if (raw === "invalid_platform_scope") return "Invalid platform scope (use instagram, tiktok, or both).";
  if (raw === "name_required") return "Template name is required.";
  if (raw === "file_required") return "Please choose a .zip file to upload.";
  if (raw === "template_in_use_no_replacement") {
    return "Template is still referenced. Upload another template first so we can reassign, then delete again.";
  }
  return raw;
}

async function uploadTemplate(formData: FormData) {
  "use server";
  const file = formData.get("file");
  if (!file || typeof (file as File).arrayBuffer !== "function") {
    const message = normalizeErrorMessage("file_required");
    redirect(`/templates?error=${encodeURIComponent(message)}`);
  }

  try {
    await createTemplateFromZip({
      name: String(formData.get("name") || ""),
      platformScope: String(formData.get("platform_scope") || "both"),
      file: file as File
    });
  } catch (err: any) {
    const message = normalizeErrorMessage(err?.message || err);
    redirect(`/templates?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/templates");
  redirect("/templates?uploaded=1");
}

function extractStoragePath(url: string | null | undefined, bucket: string) {
  if (!url) return null;
  try {
    const marker = `/storage/v1/object/public/${bucket}/`;
    const index = url.indexOf(marker);
    if (index >= 0) return url.slice(index + marker.length);
    const parsed = new URL(url);
    const parts = parsed.pathname.split(marker);
    if (parts.length > 1) return parts[1].replace(/^\/+/, "");
  } catch {
    return null;
  }
  return null;
}

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

async function removeQueuePreviewCache(postIds: string[]) {
  if (!postIds.length) return;
  const repoRoot = getRepoRoot();
  await Promise.all(
    postIds.map(postId =>
      fs.rm(path.join(repoRoot, ".cache", "queue-previews", postId), { recursive: true, force: true }).catch(() => {})
    )
  );
}

async function clearPreviewCache() {
  "use server";
  const repoRoot = getRepoRoot();
  await fs.rm(path.join(repoRoot, ".cache", "queue-previews"), { recursive: true, force: true }).catch(() => {});
  revalidatePath("/templates");
  redirect("/templates?cache_cleared=1");
}

async function deleteTemplate(formData: FormData) {
  "use server";
  const templateId = String(formData.get("template_id") || "").trim();
  if (!templateId) return;

  const supabase = createSupabaseServerClient();
  const { data: template, error } = await supabase
    .from("templates")
    .select("id,template_pack_url,preview_assets,template_hash")
    .eq("id", templateId)
    .single();
  if (error || !template?.id) {
    redirect(`/templates?error=${encodeURIComponent(error?.message || "template_not_found")}`);
  }

  const { data: affectedPosts } = await supabase
    .from("posts")
    .select("id")
    .eq("template_id", templateId);

  const { data: fallbackTemplates } = await supabase
    .from("templates")
    .select("id")
    .neq("id", templateId)
    .eq("status", "VALID")
    .order("created_at", { ascending: false })
    .limit(1);
  const fallbackTemplateId = fallbackTemplates?.[0]?.id || null;

  const { data: pillarUsage } = await supabase
    .from("pillars")
    .select("id")
    .eq("template_id", templateId)
    .limit(1);
  const { data: jobUsage } = await supabase
    .from("jobs")
    .select("id")
    .eq("template_id", templateId)
    .limit(1);
  const { data: postUsage } = await supabase
    .from("posts")
    .select("id")
    .eq("template_id", templateId)
    .limit(1);

  const hasUsage = (pillarUsage?.length || 0) > 0 || (jobUsage?.length || 0) > 0 || (postUsage?.length || 0) > 0;
  if (hasUsage && !fallbackTemplateId) {
    redirect(`/templates?error=${encodeURIComponent("template_in_use_no_replacement")}`);
  }

  if (fallbackTemplateId) {
    const { error: postsUpdateError } = await supabase
      .from("posts")
      .update({ template_id: fallbackTemplateId })
      .eq("template_id", templateId);
    if (postsUpdateError) {
      redirect(`/templates?error=${encodeURIComponent(postsUpdateError.message || "posts_template_update_failed")}`);
    }

    const { error: jobsUpdateError } = await supabase
      .from("jobs")
      .update({ template_id: fallbackTemplateId })
      .eq("template_id", templateId);
    if (jobsUpdateError) {
      redirect(`/templates?error=${encodeURIComponent(jobsUpdateError.message || "jobs_template_update_failed")}`);
    }

    const { error: pillarsUpdateError } = await supabase
      .from("pillars")
      .update({ template_id: fallbackTemplateId })
      .eq("template_id", templateId);
    if (pillarsUpdateError) {
      redirect(`/templates?error=${encodeURIComponent(pillarsUpdateError.message || "pillars_template_update_failed")}`);
    }
  }

  const { error: deleteError } = await supabase.from("templates").delete().eq("id", templateId);
  if (deleteError) {
    redirect(`/templates?error=${encodeURIComponent(deleteError.message || "template_delete_failed")}`);
  }

  const bucket = getSupabaseStorageBucket();
  const storagePaths = new Set<string>();
  const packPath = extractStoragePath(template.template_pack_url, bucket);
  if (packPath) storagePaths.add(packPath);
  if (Array.isArray(template.preview_assets)) {
    for (const asset of template.preview_assets) {
      const assetPath = extractStoragePath(asset?.url, bucket);
      if (assetPath) storagePaths.add(assetPath);
    }
  }

  if (storagePaths.size) {
    await supabase.storage.from(bucket).remove(Array.from(storagePaths)).catch(() => {});
  }

  if (template.template_hash) {
    const repoRoot = getRepoRoot();
    const buildDir = path.join(repoRoot, ".cache", "template-builds", template.template_hash);
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
  await removeQueuePreviewCache((affectedPosts || []).map(post => post.id));

  revalidatePath("/templates");
  redirect("/templates?deleted=1");
}

export default async function TemplatesPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const uploaded = Array.isArray(params.uploaded) ? params.uploaded[0] : params.uploaded;
  const deleted = Array.isArray(params.deleted) ? params.deleted[0] : params.deleted;
  const cacheCleared = Array.isArray(params.cache_cleared) ? params.cache_cleared[0] : params.cache_cleared;

  let templates: any[] = [];
  let envOrDbError: string | null = null;
  try {
    const supabase = createSupabaseServerClient();
    const { data, error: dbError } = await supabase
      .from("templates")
      .select("*")
      .order("created_at", { ascending: false });
    if (dbError) envOrDbError = dbError.message;
    templates = data || [];
  } catch (err: any) {
    envOrDbError = err?.message || String(err);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <p className="page-subtitle">
            Upload a template pack zip to validate the manifest and store render-ready assets.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Upload failed</h3>
          <p>{error}</p>
        </div>
      ) : null}

      {uploaded ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Template uploaded</h3>
          <p>Manifest validated, zip stored, and preview generation queued.</p>
        </div>
      ) : null}

      {deleted ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Template deleted</h3>
          <p>The template and preview assets were removed.</p>
        </div>
      ) : null}

      {cacheCleared ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Preview cache cleared</h3>
          <p>Queue previews will re-render the next time you open them.</p>
        </div>
      ) : null}

      {envOrDbError ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Server configuration error</h3>
          <p>{envOrDbError}</p>
          <p>
            Confirm `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and that you ran the DB migration.
          </p>
        </div>
      ) : null}

      <div className="card-grid">
        <div className="card">
          <h3>Cache tools</h3>
          <p>Clear cached queue previews so new renders are generated.</p>
          <form action={clearPreviewCache}>
            <button type="submit" className="secondary">
              Clear preview cache
            </button>
          </form>
        </div>
        <div className="card">
          <h3>Upload template pack</h3>
          <form className="form" action={uploadTemplate}>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" placeholder="Core carousel pack" required />
            </div>
            <div className="field">
              <label htmlFor="platform_scope">Platform scope</label>
              <select id="platform_scope" name="platform_scope" defaultValue="both">
                <option value="both">Instagram + TikTok</option>
                <option value="instagram">Instagram only</option>
                <option value="tiktok">TikTok only</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="file">Template pack (.zip)</label>
              <input id="file" name="file" type="file" accept=".zip" required />
            </div>
            <button type="submit">Upload template</button>
          </form>
        </div>

        <div className="card">
          <h3>Available templates</h3>
          {!templates?.length ? (
            <div className="empty">No templates yet. Upload your first pack.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Platform</th>
                  <th>Format</th>
                  <th>Status</th>
                  <th>Slides</th>
                  <th>Preview</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map(template => (
                  <tr key={template.id}>
                    <td>{template.name}</td>
                    <td>{template.platform_scope}</td>
                    <td>{template.format || template.manifest_json?.template_format || "A/B"}</td>
                    <td>{template.status || "UNKNOWN"}</td>
                    <td>{template.manifest_json?.slide_count ?? "-"}</td>
                    <td>
                      {template.preview_assets?.length ? (
                        <a className="chip" href={`/templates/${template.id}`}>
                          View preview
                        </a>
                      ) : template.status === "INVALID_RENDER" ? (
                        <span className="chip">Invalid</span>
                      ) : (
                        <span className="chip">Pending</span>
                      )}
                    </td>
                    <td>
                      <form action={deleteTemplate}>
                        <input type="hidden" name="template_id" value={template.id} />
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
