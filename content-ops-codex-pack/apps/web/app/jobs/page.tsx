import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase";
import { ingestGoogleSheetToJob } from "../../lib/ingest";
import { applyScheduleForJob } from "../../lib/scheduling";
import { cleanupStalePostArtifacts } from "../../lib/cleanup";
import { SheetValidator } from "./sheet-validator";
import { ScheduleUtcPreview } from "../components/schedule-utc-preview";
import {
  buildUtcSchedulePreview,
  isValidDateInput,
  isValidTimezone,
  parseSlotTimesWithValidation
} from "../../lib/schedule-validation";

export const dynamic = "force-dynamic";

async function validateProjectScheduleForStartDate(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  projectId: string,
  startDate: string
) {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,timezone,slot_times")
    .eq("id", projectId)
    .single();
  if (projectError || !project?.id) {
    throw new Error(projectError?.message || "project_not_found");
  }

  const timezone = String(project.timezone || "Europe/Zurich").trim() || "Europe/Zurich";
  if (!isValidTimezone(timezone)) {
    throw new Error(`invalid_project_timezone:${timezone}`);
  }
  const { slotTimes, invalid } = parseSlotTimesWithValidation(project.slot_times);
  if (invalid.length) {
    throw new Error(`invalid_project_slot_times:${invalid.join(",")}`);
  }

  buildUtcSchedulePreview({
    startDate,
    timezone,
    slotTimes,
    previewCount: 3
  });
}

async function createJob(formData: FormData) {
  "use server";
  const projectId = String(formData.get("project_id") || "").trim();
  const startDate = String(formData.get("start_date") || "").trim();
  const targetCount = Number(formData.get("target_post_count") || 21);
  const ingestSource = String(formData.get("ingest_source") || "csv");
  const sheetUrl = String(formData.get("sheet_url") || "").trim();
  const templateId = String(formData.get("template_id") || "").trim();

  if (!projectId || !startDate || !templateId) {
    redirect(`/jobs?error=${encodeURIComponent("Template, project, and start date are required.")}`);
  }
  if (!isValidDateInput(startDate)) {
    redirect(`/jobs?error=${encodeURIComponent(`invalid_start_date:${startDate}`)}`);
  }

  const resolvedIngestSource = sheetUrl ? "sheets" : ingestSource;

  const supabase = createSupabaseServerClient();
  try {
    await validateProjectScheduleForStartDate(supabase, projectId, startDate);
  } catch (error: any) {
    redirect(`/jobs?error=${encodeURIComponent(error?.message || "job_schedule_preview_invalid")}`);
  }
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .insert({
      project_id: projectId,
      start_date: startDate,
      target_post_count: Number.isNaN(targetCount) ? 21 : targetCount,
      ingest_source: resolvedIngestSource,
      status: "RUNNING",
      template_id: templateId
    })
    .select("id")
    .single();

  if (jobError || !job?.id) {
    redirect(`/jobs?error=${encodeURIComponent(jobError?.message || "job_create_failed")}`);
  }

  if (resolvedIngestSource === "sheets") {
    if (!sheetUrl) {
      redirect(`/jobs?error=${encodeURIComponent("Missing Google Sheet link for Sheets ingest.")}`);
    }

    try {
      const result = await ingestGoogleSheetToJob({ projectId, jobId: job.id, sheetUrl, templateId });
      await applyScheduleForJob(supabase, job.id);
      revalidatePath("/jobs");
      revalidatePath("/queue");
      redirect(
        `/jobs?ingested=1&created_posts=${result.createdPosts}&created_pillars=${result.createdPillars}&skipped_rows=${result.skippedRows}&invalid_json_rows=${result.invalidJsonRows}&cleaned_orphan_posts=${result.cleanedOrphanPosts}&replaced_existing_posts=${result.replacedExistingPosts}`
      );
    } catch (err: any) {
      if (err?.digest?.startsWith("NEXT_REDIRECT")) {
        throw err;
      }
      redirect(`/jobs?error=${encodeURIComponent(err?.message || "sheets_ingest_failed")}`);
    }
  }

  revalidatePath("/jobs");
  redirect("/jobs?created=1");
}

async function ingestSheetsIntoExistingJob(formData: FormData) {
  "use server";
  const jobId = String(formData.get("job_id") || "").trim();
  const sheetUrl = String(formData.get("sheet_url") || "").trim();
  if (!jobId || !sheetUrl) return;

  const supabase = createSupabaseServerClient();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,project_id,template_id")
    .eq("id", jobId)
    .single();
  if (jobError || !job?.project_id) {
    redirect(`/jobs?error=${encodeURIComponent(jobError?.message || "job_not_found")}`);
  }

  try {
    const result = await ingestGoogleSheetToJob({
      projectId: job.project_id,
      jobId: job.id,
      sheetUrl,
      templateId: job.template_id
    });
    await applyScheduleForJob(supabase, job.id);
    revalidatePath("/jobs");
    revalidatePath("/queue");
    redirect(
      `/jobs?ingested=1&created_posts=${result.createdPosts}&created_pillars=${result.createdPillars}&skipped_rows=${result.skippedRows}&invalid_json_rows=${result.invalidJsonRows}&cleaned_orphan_posts=${result.cleanedOrphanPosts}&replaced_existing_posts=${result.replacedExistingPosts}`
    );
  } catch (err: any) {
    if (err?.digest?.startsWith("NEXT_REDIRECT")) {
      throw err;
    }
    redirect(`/jobs?error=${encodeURIComponent(err?.message || "sheets_ingest_failed")}`);
  }
}

async function deleteJob(formData: FormData) {
  "use server";
  const jobId = String(formData.get("job_id") || "").trim();
  if (!jobId) return;

  const supabase = createSupabaseServerClient();
  const { error: postsError } = await supabase.from("posts").delete().eq("job_id", jobId);
  if (postsError) {
    redirect(`/jobs?error=${encodeURIComponent(postsError.message || "job_posts_delete_failed")}`);
  }

  await supabase.from("events_log").delete().eq("job_id", jobId);
  const { error } = await supabase.from("jobs").delete().eq("id", jobId);
  if (error) {
    redirect(`/jobs?error=${encodeURIComponent(error.message || "job_delete_failed")}`);
  }

  try {
    await cleanupStalePostArtifacts({ supabase });
  } catch {
    // Best-effort stale artifact cleanup after successful delete.
  }

  revalidatePath("/jobs");
  redirect("/jobs?deleted=1");
}

async function stopJob(formData: FormData) {
  "use server";
  const jobId = String(formData.get("job_id") || "").trim();
  if (!jobId) return;

  const supabase = createSupabaseServerClient();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,project_id,status")
    .eq("id", jobId)
    .single();
  if (jobError || !job?.id || !job?.project_id) {
    redirect(`/jobs?error=${encodeURIComponent(jobError?.message || "job_not_found")}`);
  }

  if (job.status === "STOPPED") {
    revalidatePath("/jobs");
    revalidatePath("/queue");
    redirect("/jobs?stopped=1&cancelled_publish_jobs=0");
  }

  const { error: stopError } = await supabase.from("jobs").update({ status: "STOPPED" }).eq("id", jobId);
  if (stopError) {
    redirect(`/jobs?error=${encodeURIComponent(stopError.message || "job_stop_failed")}`);
  }

  const { data: postRows, error: postRowsError } = await supabase.from("posts").select("id").eq("job_id", jobId);
  if (postRowsError) {
    redirect(`/jobs?error=${encodeURIComponent(postRowsError.message || "job_stop_posts_lookup_failed")}`);
  }

  const postIds = (postRows || []).map((row: any) => row.id).filter(Boolean);
  let cancelledPublishJobs = 0;
  if (postIds.length) {
    const cancellableStatuses = ["PENDING", "SENDING", "FAILED_RETRYABLE"];
    const { data: publishRows, error: publishRowsError } = await supabase
      .from("publish_jobs")
      .select("id")
      .in("post_id", postIds)
      .in("status", cancellableStatuses);
    if (publishRowsError) {
      redirect(`/jobs?error=${encodeURIComponent(publishRowsError.message || "job_stop_publish_lookup_failed")}`);
    }

    const publishIds = (publishRows || []).map((row: any) => row.id).filter(Boolean);
    cancelledPublishJobs = publishIds.length;
    if (publishIds.length) {
      const { error: cancelError } = await supabase
        .from("publish_jobs")
        .update({
          status: "CANCELLED",
          completed_at: new Date().toISOString(),
          claimed_at: null,
          claimed_by: null,
          next_retry_at: null
        })
        .in("id", publishIds);
      if (cancelError) {
        redirect(`/jobs?error=${encodeURIComponent(cancelError.message || "job_stop_publish_cancel_failed")}`);
      }
    }
  }

  const { error: eventError } = await supabase.from("events_log").insert({
    project_id: job.project_id,
    job_id: jobId,
    type: "JOB_STOPPED",
    payload: {
      cancelled_publish_jobs: cancelledPublishJobs,
      previous_status: job.status
    }
  });
  if (eventError) {
    redirect(`/jobs?error=${encodeURIComponent(eventError.message || "job_stop_event_failed")}`);
  }

  revalidatePath("/jobs");
  revalidatePath("/queue");
  redirect(`/jobs?stopped=1&cancelled_publish_jobs=${cancelledPublishJobs}`);
}

async function changeJobTemplate(formData: FormData) {
  "use server";
  const jobId = String(formData.get("job_id") || "").trim();
  const templateId = String(formData.get("template_id") || "").trim();
  if (!jobId || !templateId) {
    redirect(`/jobs?error=${encodeURIComponent("Job and template are required.")}`);
  }

  const supabase = createSupabaseServerClient();
  const { error: jobError } = await supabase
    .from("jobs")
    .update({ template_id: templateId })
    .eq("id", jobId);
  if (jobError) {
    redirect(`/jobs?error=${encodeURIComponent(jobError.message || "job_template_update_failed")}`);
  }

  const { error: postsError } = await supabase
    .from("posts")
    .update({ template_id: templateId })
    .eq("job_id", jobId);
  if (postsError) {
    redirect(`/jobs?error=${encodeURIComponent(postsError.message || "job_posts_template_update_failed")}`);
  }

  revalidatePath("/jobs");
  revalidatePath("/queue");
  redirect("/jobs?template_changed=1");
}

async function updateJobSettings(formData: FormData) {
  "use server";
  const jobId = String(formData.get("job_id") || "").trim();
  const startDate = String(formData.get("start_date") || "").trim();
  const targetCount = Number(formData.get("target_post_count") || 21);
  if (!jobId || !startDate) {
    redirect(`/jobs?error=${encodeURIComponent("Job and start date are required.")}`);
  }
  if (!isValidDateInput(startDate)) {
    redirect(`/jobs?error=${encodeURIComponent(`invalid_start_date:${startDate}`)}`);
  }

  const supabase = createSupabaseServerClient();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,project_id")
    .eq("id", jobId)
    .single();
  if (jobError || !job?.id || !job?.project_id) {
    redirect(`/jobs?error=${encodeURIComponent(jobError?.message || "job_not_found")}`);
  }
  try {
    await validateProjectScheduleForStartDate(supabase, String(job.project_id), startDate);
  } catch (schedulePreviewError: any) {
    redirect(`/jobs?error=${encodeURIComponent(schedulePreviewError?.message || "job_schedule_preview_invalid")}`);
  }

  const { error } = await supabase
    .from("jobs")
    .update({
      start_date: startDate,
      target_post_count: Number.isNaN(targetCount) ? 21 : targetCount
    })
    .eq("id", jobId);
  if (error) {
    redirect(`/jobs?error=${encodeURIComponent(error.message || "job_settings_update_failed")}`);
  }

  try {
    await applyScheduleForJob(supabase, jobId);
  } catch (scheduleError: any) {
    redirect(`/jobs?error=${encodeURIComponent(scheduleError?.message || "job_schedule_sync_failed")}`);
  }

  revalidatePath("/jobs");
  revalidatePath("/queue");
  redirect("/jobs?settings_updated=1");
}

export default async function JobsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const created = Array.isArray(params.created) ? params.created[0] : params.created;
  const ingested = Array.isArray(params.ingested) ? params.ingested[0] : params.ingested;
  const deleted = Array.isArray(params.deleted) ? params.deleted[0] : params.deleted;
  const templateChanged = Array.isArray(params.template_changed)
    ? params.template_changed[0]
    : params.template_changed;
  const settingsUpdated = Array.isArray(params.settings_updated) ? params.settings_updated[0] : params.settings_updated;
  const stopped = Array.isArray(params.stopped) ? params.stopped[0] : params.stopped;
  const cancelledPublishJobs = Array.isArray(params.cancelled_publish_jobs)
    ? params.cancelled_publish_jobs[0]
    : params.cancelled_publish_jobs;
  const createdPosts = Array.isArray(params.created_posts) ? params.created_posts[0] : params.created_posts;
  const createdPillars = Array.isArray(params.created_pillars) ? params.created_pillars[0] : params.created_pillars;
  const skippedRows = Array.isArray(params.skipped_rows) ? params.skipped_rows[0] : params.skipped_rows;
  const invalidJsonRows = Array.isArray(params.invalid_json_rows) ? params.invalid_json_rows[0] : params.invalid_json_rows;
  const cleanedOrphanPosts = Array.isArray(params.cleaned_orphan_posts)
    ? params.cleaned_orphan_posts[0]
    : params.cleaned_orphan_posts;
  const replacedExistingPosts = Array.isArray(params.replaced_existing_posts)
    ? params.replaced_existing_posts[0]
    : params.replaced_existing_posts;

  const supabase = createSupabaseServerClient();
  const { data: projectsData } = await supabase
    .from("projects")
    .select("id,name,timezone,slot_times")
    .order("created_at", { ascending: false });
  const { data: jobsData } = await supabase
    .from("jobs")
    .select(
      "id,status,start_date,target_post_count,ingest_source,template_id,projects(name,timezone,slot_times),templates(name)"
    )
    .order("created_at", { ascending: false });

  const projects = (projectsData || []) as any[];
  const jobs = (jobsData || []) as any[];
  const projectSchedules = projects.reduce<Record<string, { timezone: string; slotTimes: string[] }>>((acc, project) => {
    acc[project.id] = {
      timezone: String(project.timezone || "Europe/Zurich"),
      slotTimes: Array.isArray(project.slot_times) ? project.slot_times.map((value: any) => String(value)) : []
    };
    return acc;
  }, {});
  const { data: templatesData } = await supabase
    .from("templates")
    .select("id,name,format,status,created_at")
    .neq("status", "INVALID_RENDER")
    .order("created_at", { ascending: false });
  const templates = (templatesData || []) as any[];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="page-subtitle">
            Spin up weekly batches (default 21 posts) and keep the cadence aligned with slots.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Job creation failed</h3>
          <p>{error}</p>
        </div>
      ) : null}

      {created ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Job created</h3>
          <p>Now add posts via ingest (CSV/Sheets) or manual entry.</p>
        </div>
      ) : null}

      {ingested ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Sheets ingest complete</h3>
          <p>
            Created {createdPosts || "0"} posts, created {createdPillars || "0"} pillars, skipped{" "}
            {skippedRows || "0"} rows.
            {invalidJsonRows ? ` ${invalidJsonRows} row(s) had invalid slide JSON and were auto-repaired.` : ""}
            {cleanedOrphanPosts ? ` Cleaned ${cleanedOrphanPosts} broken post(s) with missing slides.` : ""}
            {replacedExistingPosts ? ` Replaced ${replacedExistingPosts} pre-existing post(s) in this job.` : ""}
          </p>
        </div>
      ) : null}

      {deleted ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Job deleted</h3>
          <p>The job was removed. Posts keep their project but no longer reference this job.</p>
        </div>
      ) : null}

      {templateChanged ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Template updated</h3>
          <p>The job and its posts now point to the selected template.</p>
        </div>
      ) : null}

      {settingsUpdated ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Job settings updated</h3>
          <p>Start date/target were saved and post publish timestamps were resynced from project slots.</p>
        </div>
      ) : null}

      {stopped ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Job stopped</h3>
          <p>
            Publishing was cancelled for this job. Cancelled {cancelledPublishJobs || "0"} active publish job(s).
          </p>
        </div>
      ) : null}

      <div className="card-grid">
        <div className="card">
          <h3>Create a job</h3>
          <form className="form" action={createJob}>
            <div className="field">
              <label htmlFor="template_id">Template</label>
              <select id="template_id" name="template_id" required defaultValue={templates?.[0]?.id || ""}>
                <option value="">Select a template</option>
                {templates?.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name} (Format {template.format})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="project_id">Project</label>
              <select id="project_id" name="project_id" required>
                <option value="">Select a project</option>
                {projects?.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="start_date">Start date</label>
              <input id="start_date" name="start_date" type="date" required />
            </div>
            <ScheduleUtcPreview
              title="Schedule UTC preview"
              projectSelectId="project_id"
              startDateInputId="start_date"
              projectSchedules={projectSchedules}
            />
            <div className="field">
              <label htmlFor="target_post_count">Target posts</label>
              <input id="target_post_count" name="target_post_count" type="number" defaultValue={21} />
            </div>
            <div className="field">
              <label htmlFor="ingest_source">Ingest source</label>
              <select id="ingest_source" name="ingest_source" defaultValue="csv">
                <option value="csv">CSV</option>
                <option value="sheets">Google Sheets</option>
                <option value="manual">Manual entry</option>
                <option value="ai">AI generation</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="sheet_url">Google Sheets link (optional; if set, we ingest Sheets)</label>
              <input
                id="sheet_url"
                name="sheet_url"
                placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
              />
            </div>
            <button type="submit">Create job</button>
          </form>
          <SheetValidator />
        </div>

        <div className="card">
          <h3>Recent jobs</h3>
          {!jobs.length ? (
            <div className="empty">No jobs yet. Create one to schedule posts.</div>
          ) : (
            <div className="table-scroll">
              <table className="table table-wide">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Template</th>
                    <th>Status</th>
                    <th>Ingest</th>
                    <th>Start</th>
                    <th>Target</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job: any) => {
                    const project = Array.isArray(job.projects) ? job.projects[0] : job.projects;
                    const jobTimezone = String(project?.timezone || "Europe/Zurich");
                    const jobSlotTimes = Array.isArray(project?.slot_times)
                      ? project.slot_times.map((value: any) => String(value))
                      : [];
                    return (
                    <tr key={job.id}>
                      <td>
                        {(Array.isArray(job.projects) ? job.projects[0]?.name : job.projects?.name) || job.id}
                      </td>
                      <td>
                        {(Array.isArray(job.templates) ? job.templates[0]?.name : job.templates?.name) ||
                          job.template_id ||
                          "—"}
                      </td>
                      <td>{job.status}</td>
                      <td>{job.ingest_source}</td>
                      <td>{job.start_date}</td>
                      <td>{job.target_post_count}</td>
                      <td>
                        <details>
                          <summary className="chip" style={{ cursor: "pointer" }}>
                            Ingest sheets
                          </summary>
                          <form className="form" action={ingestSheetsIntoExistingJob} style={{ marginTop: 12 }}>
                            <input type="hidden" name="job_id" value={job.id} />
                            <div className="field">
                              <label htmlFor={`sheet_url_${job.id}`}>Google Sheets link</label>
                              <input
                                id={`sheet_url_${job.id}`}
                                name="sheet_url"
                                placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
                                required
                              />
                            </div>
                            <button type="submit">Ingest into this job</button>
                          </form>
                        </details>
                        <details style={{ marginTop: 12 }}>
                          <summary className="chip" style={{ cursor: "pointer" }}>
                            Change template
                          </summary>
                          <form className="form" action={changeJobTemplate} style={{ marginTop: 12 }}>
                            <input type="hidden" name="job_id" value={job.id} />
                            <div className="field">
                              <label htmlFor={`template_id_${job.id}`}>Template</label>
                              <select
                                id={`template_id_${job.id}`}
                                name="template_id"
                                defaultValue={job.template_id || ""}
                                required
                              >
                                <option value="">Select a template</option>
                                {templates?.map(template => (
                                  <option key={template.id} value={template.id}>
                                    {template.name} (Format {template.format})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <button type="submit">Update template</button>
                          </form>
                        </details>
                        <details style={{ marginTop: 12 }}>
                          <summary className="chip" style={{ cursor: "pointer" }}>
                            Edit schedule
                          </summary>
                          <form className="form" action={updateJobSettings} style={{ marginTop: 12 }}>
                            <input type="hidden" name="job_id" value={job.id} />
                            <div className="field">
                              <label htmlFor={`job_start_${job.id}`}>Start date</label>
                              <input id={`job_start_${job.id}`} name="start_date" type="date" defaultValue={job.start_date} required />
                            </div>
                            <ScheduleUtcPreview
                              title="Schedule UTC preview"
                              startDateInputId={`job_start_${job.id}`}
                              fixedTimezone={jobTimezone}
                              fixedSlotTimes={jobSlotTimes}
                            />
                            <div className="field">
                              <label htmlFor={`job_target_${job.id}`}>Target posts</label>
                              <input
                                id={`job_target_${job.id}`}
                                name="target_post_count"
                                type="number"
                                defaultValue={job.target_post_count || 21}
                              />
                            </div>
                            <button type="submit">Save + resync schedule</button>
                          </form>
                        </details>
                        <form action={deleteJob} style={{ marginTop: 12 }}>
                          <input type="hidden" name="job_id" value={job.id} />
                          <button type="submit" className="secondary">
                            Delete job
                          </button>
                        </form>
                        {job.status !== "STOPPED" ? (
                          <form action={stopJob} style={{ marginTop: 12 }}>
                            <input type="hidden" name="job_id" value={job.id} />
                            <button type="submit" className="secondary">
                              Stop job
                            </button>
                          </form>
                        ) : (
                          <div style={{ marginTop: 12 }}>
                            <span className="chip">Stopped</span>
                          </div>
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
      </div>
    </div>
  );
}
