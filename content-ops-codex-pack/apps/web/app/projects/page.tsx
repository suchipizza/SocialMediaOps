import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import path from "node:path";
import fs from "node:fs/promises";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "../../lib/supabase";
import { applyScheduleForProjectJobs } from "../../lib/scheduling";
import { cleanupStalePostArtifacts } from "../../lib/cleanup";
import { ScheduleUtcPreview } from "../components/schedule-utc-preview";
import {
  buildUtcSchedulePreview,
  isValidTimezone,
  parseSlotTimesWithValidation
} from "../../lib/schedule-validation";

function normalizeAccountId(value: FormDataEntryValue | null) {
  const parsed = String(value || "").trim();
  return parsed || null;
}

const FALLBACK_TIMEZONES = [
  "Europe/Zurich",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney"
];

function getTimezoneOptions() {
  const intlWithSupported = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  const supported = intlWithSupported.supportedValuesOf?.("timeZone");
  if (Array.isArray(supported) && supported.length) {
    return [...supported].sort((a, b) => a.localeCompare(b));
  }
  return [...FALLBACK_TIMEZONES];
}

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function validateSchedulePreviewOrThrow(timezone: string, slotTimes: string[]) {
  buildUtcSchedulePreview({
    startDate: getTodayIsoDate(),
    timezone,
    slotTimes,
    previewCount: 3
  });
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Buffer.isBuffer(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readCredential(config: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = config[key];
    if (value) return String(value).trim();
  }
  return "";
}

async function readJsonSafe(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
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

async function removeQueuePreviewCache(postIds: string[]) {
  if (!postIds.length) return;
  const repoRoot = getRepoRoot();
  await Promise.all(
    postIds.map(postId =>
      fs
        .rm(path.join(repoRoot, ".cache", "queue-previews", postId), { recursive: true, force: true })
        .catch(() => {})
    )
  );
}

async function removeStoragePaths(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  bucket: string,
  paths: string[]
) {
  if (!paths.length) return;
  const uniquePaths = Array.from(new Set(paths));
  const chunkSize = 100;
  for (let index = 0; index < uniquePaths.length; index += chunkSize) {
    const chunk = uniquePaths.slice(index, index + chunkSize);
    const { error } = await supabase.storage.from(bucket).remove(chunk);
    if (error) {
      throw new Error(`storage_cleanup_failed:${error.message}`);
    }
  }
}

async function createSocialAccount(formData: FormData) {
  "use server";
  const platform = String(formData.get("platform") || "").trim().toLowerCase();
  const name = String(formData.get("name") || "").trim();
  const igAccessToken = String(formData.get("ig_access_token") || "").trim();
  const igUserId = String(formData.get("ig_user_id") || "").trim();
  const tiktokAccessToken = String(formData.get("tiktok_access_token") || "").trim();
  const tiktokUserId = String(formData.get("tiktok_user_id") || "").trim();

  if (!name || (platform !== "instagram" && platform !== "tiktok")) {
    redirect("/projects?error=account_name_and_platform_required");
  }

  let credentials: Record<string, string> = {};
  if (platform === "instagram") {
    if (!igAccessToken || !igUserId) {
      redirect("/projects?error=instagram_credentials_required");
    }
    credentials = {
      ig_access_token: igAccessToken,
      ig_user_id: igUserId
    };
  } else {
    if (!tiktokAccessToken || !tiktokUserId) {
      redirect("/projects?error=tiktok_credentials_required");
    }
    credentials = {
      access_token: tiktokAccessToken,
      user_id: tiktokUserId
    };
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from("social_accounts").insert({
    platform,
    name,
    credentials_json: credentials
  });
  if (error) {
    redirect(`/projects?error=${encodeURIComponent(error.message || "account_create_failed")}`);
  }

  revalidatePath("/projects");
  redirect("/projects?account_created=1");
}

async function deleteSocialAccount(formData: FormData) {
  "use server";
  const accountId = String(formData.get("account_id") || "").trim();
  if (!accountId) return;

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from("social_accounts").delete().eq("id", accountId);
  if (error) {
    redirect(`/projects?error=${encodeURIComponent(error.message || "account_delete_failed")}`);
  }

  revalidatePath("/projects");
  redirect("/projects?account_deleted=1");
}

async function testInstagramAccountCredentials(formData: FormData) {
  "use server";
  const accountId = String(formData.get("account_id") || "").trim();
  if (!accountId) return;

  const supabase = createSupabaseServerClient();
  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("id,name,platform,credentials_json")
    .eq("id", accountId)
    .single();
  if (error || !account?.id) {
    redirect(`/projects?error=${encodeURIComponent(error?.message || "account_not_found")}`);
  }
  if (account.platform !== "instagram") {
    redirect("/projects?error=account_not_instagram");
  }

  const credentials = parseJsonObject(account.credentials_json);
  const igAccessToken = readCredential(credentials, [
    "ig_access_token",
    "access_token",
    "igAccessToken",
    "accessToken"
  ]);
  const igUserId = readCredential(credentials, ["ig_user_id", "user_id", "igUserId", "userId"]);
  if (!igAccessToken || !igUserId) {
    redirect(
      `/projects?account_test_error=${encodeURIComponent(
        "missing_ig_access_token_or_ig_user_id"
      )}&account_test_name=${encodeURIComponent(account.name)}`
    );
  }

  const graphVersion = process.env.IG_GRAPH_API_VERSION || "v21.0";
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${igUserId}`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", igAccessToken);

  const response = await fetch(url.toString(), { method: "GET" });
  const payload = await readJsonSafe(response);
  if (!response.ok) {
    const graphMessage = String(payload?.error?.message || `graph_error_${response.status}`);
    redirect(
      `/projects?account_test_error=${encodeURIComponent(graphMessage)}&account_test_name=${encodeURIComponent(
        account.name
      )}`
    );
  }

  revalidatePath("/projects");
  const username = String(payload?.username || payload?.id || igUserId);
  redirect(
    `/projects?account_test_ok=1&account_test_name=${encodeURIComponent(
      account.name
    )}&account_test_username=${encodeURIComponent(username)}`
  );
}

async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const timezone = String(formData.get("timezone") || "Europe/Zurich").trim() || "Europe/Zurich";
  const { slotTimes, invalid } = parseSlotTimesWithValidation(formData.get("slot_times"));
  const platformsEnabled = {
    instagram: formData.get("platform_instagram") === "on",
    tiktok: formData.get("platform_tiktok") === "on"
  };
  const instagramAccountId = normalizeAccountId(formData.get("instagram_account_id"));
  const tiktokAccountId = normalizeAccountId(formData.get("tiktok_account_id"));

  if (!name) {
    return;
  }
  if (!isValidTimezone(timezone)) {
    redirect(`/projects?error=${encodeURIComponent(`invalid_timezone:${timezone}`)}`);
  }
  if (invalid.length) {
    redirect(`/projects?error=${encodeURIComponent(`invalid_slot_times:${invalid.join(",")}`)}`);
  }
  try {
    validateSchedulePreviewOrThrow(timezone, slotTimes);
  } catch (error: any) {
    redirect(`/projects?error=${encodeURIComponent(error?.message || "project_schedule_preview_invalid")}`);
  }

  const supabase = createSupabaseServerClient();
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      name,
      description: description || null,
      timezone: timezone || "Europe/Zurich",
      slot_times: slotTimes,
      platforms_enabled: platformsEnabled
    })
    .select("id")
    .single();
  if (projectError || !project?.id) {
    redirect(`/projects?error=${encodeURIComponent(projectError?.message || "project_create_failed")}`);
  }

  const accountIds = [instagramAccountId, tiktokAccountId].filter(Boolean) as string[];
  if (accountIds.length) {
    const links = accountIds.map(accountId => ({ project_id: project.id, account_id: accountId }));
    const { error: linkError } = await supabase.from("project_social_accounts").insert(links);
    if (linkError) {
      redirect(`/projects?error=${encodeURIComponent(linkError.message || "project_account_link_failed")}`);
    }
  }

  revalidatePath("/projects");
  redirect("/projects?created=1");
}

async function updateProjectSettings(formData: FormData) {
  "use server";
  const projectId = String(formData.get("project_id") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const timezone = String(formData.get("timezone") || "").trim() || "Europe/Zurich";
  const { slotTimes, invalid } = parseSlotTimesWithValidation(formData.get("slot_times"));

  if (!projectId || !name) {
    redirect("/projects?error=project_id_and_name_required");
  }
  if (!isValidTimezone(timezone)) {
    redirect(`/projects?error=${encodeURIComponent(`invalid_timezone:${timezone}`)}`);
  }
  if (invalid.length) {
    redirect(`/projects?error=${encodeURIComponent(`invalid_slot_times:${invalid.join(",")}`)}`);
  }
  try {
    validateSchedulePreviewOrThrow(timezone, slotTimes);
  } catch (error: any) {
    redirect(`/projects?error=${encodeURIComponent(error?.message || "project_schedule_preview_invalid")}`);
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("projects")
    .update({
      name,
      description: description || null,
      timezone,
      slot_times: slotTimes
    })
    .eq("id", projectId);
  if (error) {
    redirect(`/projects?error=${encodeURIComponent(error.message || "project_settings_update_failed")}`);
  }

  try {
    await applyScheduleForProjectJobs(supabase, projectId);
  } catch (scheduleError: any) {
    redirect(`/projects?error=${encodeURIComponent(scheduleError?.message || "project_schedule_sync_failed")}`);
  }

  revalidatePath("/projects");
  revalidatePath("/jobs");
  revalidatePath("/queue");
  redirect("/projects?settings_updated=1");
}

async function updateProjectAccounts(formData: FormData) {
  "use server";
  const projectId = String(formData.get("project_id") || "").trim();
  if (!projectId) return;

  const instagramAccountId = normalizeAccountId(formData.get("instagram_account_id"));
  const tiktokAccountId = normalizeAccountId(formData.get("tiktok_account_id"));
  const platformsEnabled = {
    instagram: formData.get("platform_instagram") === "on",
    tiktok: formData.get("platform_tiktok") === "on"
  };

  const supabase = createSupabaseServerClient();
  const { error: projectError } = await supabase
    .from("projects")
    .update({ platforms_enabled: platformsEnabled })
    .eq("id", projectId);
  if (projectError) {
    redirect(`/projects?error=${encodeURIComponent(projectError.message || "project_update_failed")}`);
  }

  const { error: deleteError } = await supabase
    .from("project_social_accounts")
    .delete()
    .eq("project_id", projectId);
  if (deleteError) {
    redirect(`/projects?error=${encodeURIComponent(deleteError.message || "project_account_unlink_failed")}`);
  }

  const accountIds = [instagramAccountId, tiktokAccountId].filter(Boolean) as string[];
  if (accountIds.length) {
    const links = accountIds.map(accountId => ({ project_id: projectId, account_id: accountId }));
    const { error: insertError } = await supabase.from("project_social_accounts").insert(links);
    if (insertError) {
      redirect(`/projects?error=${encodeURIComponent(insertError.message || "project_account_link_failed")}`);
    }
  }

  revalidatePath("/projects");
  redirect("/projects?accounts_updated=1");
}

async function deleteProject(formData: FormData) {
  "use server";
  const projectId = String(formData.get("project_id") || "").trim();
  if (!projectId) return;

  const supabase = createSupabaseServerClient();

  const { data: projectPosts, error: postsError } = await supabase
    .from("posts")
    .select("id")
    .eq("project_id", projectId);
  if (postsError) {
    redirect(`/projects?error=${encodeURIComponent(postsError.message || "project_posts_fetch_failed")}`);
  }
  const postIds = (projectPosts || []).map(post => post.id);

  if (postIds.length) {
    const { data: projectAssets, error: assetsError } = await supabase
      .from("assets")
      .select("image_url")
      .in("post_id", postIds);
    if (assetsError) {
      redirect(`/projects?error=${encodeURIComponent(assetsError.message || "project_assets_fetch_failed")}`);
    }

    const bucket = getSupabaseStorageBucket();
    const storagePaths = (projectAssets || [])
      .map(asset => extractStoragePath(asset.image_url, bucket))
      .filter(Boolean) as string[];

    try {
      await removeStoragePaths(supabase, bucket, storagePaths);
    } catch (error: any) {
      redirect(`/projects?error=${encodeURIComponent(error?.message || "project_storage_cleanup_failed")}`);
    }

    await removeQueuePreviewCache(postIds);
  }

  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) {
    redirect(`/projects?error=${encodeURIComponent(error.message || "project_delete_failed")}`);
  }

  try {
    await cleanupStalePostArtifacts({ supabase });
  } catch {
    // Best-effort stale artifact cleanup after successful delete.
  }

  revalidatePath("/projects");
  revalidatePath("/queue");
  revalidatePath("/jobs");
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
  const created = Array.isArray(params.created) ? params.created[0] : params.created;
  const accountCreated = Array.isArray(params.account_created) ? params.account_created[0] : params.account_created;
  const accountDeleted = Array.isArray(params.account_deleted) ? params.account_deleted[0] : params.account_deleted;
  const accountTestOk = Array.isArray(params.account_test_ok) ? params.account_test_ok[0] : params.account_test_ok;
  const accountTestName = Array.isArray(params.account_test_name) ? params.account_test_name[0] : params.account_test_name;
  const accountTestUsername = Array.isArray(params.account_test_username)
    ? params.account_test_username[0]
    : params.account_test_username;
  const accountTestError = Array.isArray(params.account_test_error) ? params.account_test_error[0] : params.account_test_error;
  const accountsUpdated = Array.isArray(params.accounts_updated) ? params.accounts_updated[0] : params.accounts_updated;
  const settingsUpdated = Array.isArray(params.settings_updated) ? params.settings_updated[0] : params.settings_updated;
  const supabase = createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id,platform,name,created_at")
    .order("created_at", { ascending: false });
  const { data: projectAccountLinks } = await supabase
    .from("project_social_accounts")
    .select("project_id,account_id,social_accounts(id,platform,name)");

  const instagramAccounts = (accounts || []).filter((account: any) => account.platform === "instagram");
  const tiktokAccounts = (accounts || []).filter((account: any) => account.platform === "tiktok");
  const timezoneOptions = getTimezoneOptions();
  const linkMap = new Map<string, { instagram?: string; tiktok?: string; labels: string[] }>();
  for (const link of projectAccountLinks || []) {
    const account = Array.isArray(link.social_accounts) ? link.social_accounts[0] : link.social_accounts;
    if (!account?.id || !link.project_id) continue;
    const current = linkMap.get(link.project_id) || { labels: [] };
    current[account.platform as "instagram" | "tiktok"] = account.id;
    current.labels.push(`${account.platform}:${account.name}`);
    linkMap.set(link.project_id, current);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="page-subtitle">
            Each project bundles platforms, pillars, schedules, and linked social accounts.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Project update failed</h3>
          <p>{error}</p>
        </div>
      ) : null}

      {created ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Project created</h3>
          <p>Project and selected account links were saved.</p>
        </div>
      ) : null}

      {deleted ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Project deleted</h3>
          <p>All related jobs, posts, publish queue records, assets, and queue preview cache were removed.</p>
        </div>
      ) : null}

      {accountCreated ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Account created</h3>
          <p>You can now link it to projects.</p>
        </div>
      ) : null}

      {accountDeleted ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Account deleted</h3>
          <p>Linked projects were automatically unlinked.</p>
        </div>
      ) : null}

      {accountTestOk ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Instagram credentials are valid</h3>
          <p>
            Account <strong>{accountTestName || "instagram"}</strong> validated successfully
            {accountTestUsername ? ` (${accountTestUsername})` : ""}.
          </p>
        </div>
      ) : null}

      {accountTestError ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Instagram credentials test failed</h3>
          <p>
            {accountTestName ? `${accountTestName}: ` : ""}
            {accountTestError}
          </p>
        </div>
      ) : null}

      {accountsUpdated ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Project accounts updated</h3>
          <p>Linked accounts and publishing platforms were updated.</p>
        </div>
      ) : null}

      {settingsUpdated ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Project settings updated</h3>
          <p>Timezone and time slots are saved and take effect immediately for scheduling logic.</p>
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
              <select id="timezone" name="timezone" defaultValue="Europe/Zurich">
                {timezoneOptions.map(timezone => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="slot_times">Daily slots (comma separated)</label>
              <input id="slot_times" name="slot_times" defaultValue="09:00,13:00,18:00" />
            </div>
            <ScheduleUtcPreview
              title="Timezone to UTC preview"
              timezoneInputId="timezone"
              slotTimesInputId="slot_times"
            />
            <div className="field">
              <label>Platforms</label>
              <label>
                <input type="checkbox" name="platform_instagram" defaultChecked /> Instagram
              </label>
              <label>
                <input type="checkbox" name="platform_tiktok" /> TikTok
              </label>
            </div>
            <div className="field">
              <label htmlFor="instagram_account_id">Instagram account (optional)</label>
              <select id="instagram_account_id" name="instagram_account_id" defaultValue="">
                <option value="">No linked account</option>
                {instagramAccounts.map((account: any) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tiktok_account_id">TikTok account (optional)</label>
              <select id="tiktok_account_id" name="tiktok_account_id" defaultValue="">
                <option value="">No linked account</option>
                {tiktokAccounts.map((account: any) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit">Create project</button>
          </form>
        </div>

        <div className="card">
          <h3>Account settings</h3>
          <form className="form" action={createSocialAccount}>
            <div className="field">
              <label htmlFor="platform">Platform</label>
              <select id="platform" name="platform" defaultValue="instagram" required>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="account_name">Account name (internal label)</label>
              <input id="account_name" name="name" placeholder="USV2 Primary IG" required />
            </div>
            <div className="field">
              <label htmlFor="ig_access_token">Instagram access token</label>
              <input id="ig_access_token" name="ig_access_token" placeholder="IG token" />
            </div>
            <div className="field">
              <label htmlFor="ig_user_id">Instagram user id</label>
              <input id="ig_user_id" name="ig_user_id" placeholder="1784..." />
            </div>
            <div className="field">
              <label htmlFor="tiktok_access_token">TikTok access token</label>
              <input id="tiktok_access_token" name="tiktok_access_token" placeholder="TikTok token" />
            </div>
            <div className="field">
              <label htmlFor="tiktok_user_id">TikTok user id/open id</label>
              <input id="tiktok_user_id" name="tiktok_user_id" placeholder="TikTok user id" />
            </div>
            <button type="submit">Add account</button>
          </form>

          <h3 style={{ marginTop: 20 }}>Stored accounts</h3>
          {!accounts?.length ? (
            <div className="empty">No accounts stored yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Platform</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account: any) => (
                    <tr key={account.id}>
                      <td>{account.name}</td>
                      <td>{account.platform}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {account.platform === "instagram" ? (
                            <form action={testInstagramAccountCredentials}>
                              <input type="hidden" name="account_id" value={account.id} />
                              <button type="submit">Test credentials</button>
                            </form>
                          ) : null}
                          <form action={deleteSocialAccount}>
                            <input type="hidden" name="account_id" value={account.id} />
                            <button type="submit" className="secondary">
                              Delete
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Active projects</h3>
          {!projects?.length ? (
            <div className="empty">No projects yet. Create your first above.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Timezone</th>
                    <th>Slots</th>
                    <th>Linked accounts</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project: any) => {
                    const linked = linkMap.get(project.id) || { labels: [] };
                    const enabled = project.platforms_enabled || {};
                    return (
                      <tr key={project.id}>
                        <td>{project.name}</td>
                        <td>{project.timezone}</td>
                        <td>{(project.slot_times || []).join(", ")}</td>
                        <td>{linked.labels.length ? linked.labels.join(", ") : "—"}</td>
                        <td>
                          <details>
                            <summary className="chip" style={{ cursor: "pointer" }}>
                              Edit settings
                            </summary>
                            <form className="form" action={updateProjectSettings} style={{ marginTop: 12 }}>
                              <input type="hidden" name="project_id" value={project.id} />
                              <div className="field">
                                <label htmlFor={`project_name_${project.id}`}>Project name</label>
                                <input
                                  id={`project_name_${project.id}`}
                                  name="name"
                                  defaultValue={project.name || ""}
                                  required
                                />
                              </div>
                              <div className="field">
                                <label htmlFor={`project_description_${project.id}`}>Description</label>
                                <textarea
                                  id={`project_description_${project.id}`}
                                  name="description"
                                  defaultValue={project.description || ""}
                                  rows={3}
                                />
                              </div>
                              <div className="field">
                                <label htmlFor={`project_timezone_${project.id}`}>Timezone</label>
                                <select
                                  id={`project_timezone_${project.id}`}
                                  name="timezone"
                                  defaultValue={project.timezone || "Europe/Zurich"}
                                >
                                  {!timezoneOptions.includes(project.timezone || "") && project.timezone ? (
                                    <option value={project.timezone}>{project.timezone}</option>
                                  ) : null}
                                  {timezoneOptions.map(timezone => (
                                    <option key={timezone} value={timezone}>
                                      {timezone}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label htmlFor={`project_slots_${project.id}`}>Daily slots (comma separated)</label>
                                <input
                                  id={`project_slots_${project.id}`}
                                  name="slot_times"
                                  defaultValue={(project.slot_times || []).join(", ") || "09:00,13:00,18:00"}
                                />
                              </div>
                              <ScheduleUtcPreview
                                title="Timezone to UTC preview"
                                timezoneInputId={`project_timezone_${project.id}`}
                                slotTimesInputId={`project_slots_${project.id}`}
                              />
                              <button type="submit">Save settings</button>
                            </form>
                          </details>
                          <details>
                            <summary className="chip" style={{ cursor: "pointer" }}>
                              Link accounts
                            </summary>
                            <form className="form" action={updateProjectAccounts} style={{ marginTop: 12 }}>
                              <input type="hidden" name="project_id" value={project.id} />
                              <div className="field">
                                <label>
                                  <input
                                    type="checkbox"
                                    name="platform_instagram"
                                    defaultChecked={enabled.instagram !== false}
                                  />{" "}
                                  Post to Instagram
                                </label>
                                <label>
                                  <input type="checkbox" name="platform_tiktok" defaultChecked={enabled.tiktok === true} />{" "}
                                  Post to TikTok
                                </label>
                              </div>
                              <div className="field">
                                <label htmlFor={`instagram_account_id_${project.id}`}>Instagram account</label>
                                <select
                                  id={`instagram_account_id_${project.id}`}
                                  name="instagram_account_id"
                                  defaultValue={linked.instagram || ""}
                                >
                                  <option value="">No linked account</option>
                                  {instagramAccounts.map((account: any) => (
                                    <option key={account.id} value={account.id}>
                                      {account.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label htmlFor={`tiktok_account_id_${project.id}`}>TikTok account</label>
                                <select
                                  id={`tiktok_account_id_${project.id}`}
                                  name="tiktok_account_id"
                                  defaultValue={linked.tiktok || ""}
                                >
                                  <option value="">No linked account</option>
                                  {tiktokAccounts.map((account: any) => (
                                    <option key={account.id} value={account.id}>
                                      {account.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button type="submit">Save account links</button>
                            </form>
                          </details>
                          <form action={deleteProject} style={{ marginTop: 12 }}>
                            <input type="hidden" name="project_id" value={project.id} />
                            <button type="submit" className="secondary">
                              Delete
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
