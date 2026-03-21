import {
  addDays,
  isValidDateInput,
  isValidTimezone,
  parseSlotTimesWithValidation,
  zonedDateTimeToUtcIso
} from "./schedule-validation";

const ACTIVE_PUBLISH_STATUSES = ["PENDING", "FAILED_RETRYABLE", "SENDING"];

type SupabaseLike = {
  from: (table: string) => any;
};

type JobScheduleContext = {
  id: string;
  start_date: string;
  project_id: string;
  projects?: { timezone?: string | null; slot_times?: unknown } | Array<{ timezone?: string | null; slot_times?: unknown }> | null;
};

export function parseSlotTimes(input: unknown) {
  return parseSlotTimesWithValidation(input).slotTimes;
}

function pickProjectConfig(projects: JobScheduleContext["projects"]) {
  if (Array.isArray(projects)) return projects[0] || {};
  return projects || {};
}

export async function applyScheduleForJob(supabase: SupabaseLike, jobId: string) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) throw new Error("job_id_required");

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,start_date,project_id,projects(timezone,slot_times)")
    .eq("id", normalizedJobId)
    .single();
  if (jobError || !job?.id) throw new Error(`job_not_found:${jobError?.message || normalizedJobId}`);
  if (!job.start_date || !isValidDateInput(String(job.start_date))) {
    throw new Error(`job_start_date_required:${job.start_date || "missing"}`);
  }

  const project = pickProjectConfig((job as JobScheduleContext).projects);
  const timezone = String(project.timezone || "Europe/Zurich");
  if (!isValidTimezone(timezone)) {
    throw new Error(`invalid_project_timezone:${timezone}`);
  }
  const { slotTimes, invalid } = parseSlotTimesWithValidation(project.slot_times);
  if (invalid.length) {
    throw new Error(`invalid_project_slot_times:${invalid.join(",")}`);
  }

  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("id,ordering_index,created_at")
    .eq("job_id", normalizedJobId)
    .order("ordering_index", { ascending: true })
    .order("created_at", { ascending: true });
  if (postsError) throw new Error(`job_posts_fetch_failed:${postsError.message}`);

  const sortedPosts = [...(posts || [])].sort((a, b) => {
    const orderA = Number(a.ordering_index || 0);
    const orderB = Number(b.ordering_index || 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });

  let updates = 0;
  for (let index = 0; index < sortedPosts.length; index += 1) {
    const post = sortedPosts[index];
    const slot = slotTimes[index % slotTimes.length];
    const dayOffset = Math.floor(index / slotTimes.length);
    const scheduleDate = addDays(job.start_date, dayOffset);
    const scheduledAt = zonedDateTimeToUtcIso(scheduleDate, slot, timezone);

    const { error: postUpdateError } = await supabase
      .from("posts")
      .update({ scheduled_at: scheduledAt })
      .eq("id", post.id);
    if (postUpdateError) throw new Error(`post_schedule_update_failed:${postUpdateError.message}`);

    const { error: publishUpdateError } = await supabase
      .from("publish_jobs")
      .update({ scheduled_at: scheduledAt })
      .eq("post_id", post.id)
      .in("status", ACTIVE_PUBLISH_STATUSES);
    if (publishUpdateError) throw new Error(`publish_schedule_update_failed:${publishUpdateError.message}`);

    updates += 1;
  }

  return { updatedPosts: updates, timezone, slotTimes };
}

export async function applyScheduleForProjectJobs(supabase: SupabaseLike, projectId: string) {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) throw new Error("project_id_required");

  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("project_id", normalizedProjectId);
  if (error) throw new Error(`project_jobs_fetch_failed:${error.message}`);

  let jobsUpdated = 0;
  let postsUpdated = 0;
  for (const job of jobs || []) {
    const result = await applyScheduleForJob(supabase, job.id);
    jobsUpdated += 1;
    postsUpdated += result.updatedPosts;
  }

  return { jobsUpdated, postsUpdated };
}
