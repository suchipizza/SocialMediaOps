const DEFAULT_SLOTS = ["09:00", "13:00", "18:00"];
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

function parseOffsetMs(offsetLabel: string) {
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2], 10) || 0;
  const minutes = Number.parseInt(match[3] || "0", 10) || 0;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function getOffsetMsAt(utcDate: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(utcDate);
  const zone = parts.find(part => part.type === "timeZoneName")?.value || "GMT+00:00";
  return parseOffsetMs(zone);
}

function zonedDateTimeToUtcIso(dateStr: string, timeStr: string, timezone: string) {
  const [year, month, day] = dateStr.split("-").map(value => Number.parseInt(value, 10));
  const [hour, minute] = timeStr.split(":").map(value => Number.parseInt(value, 10));
  const baseUtc = Date.UTC(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);

  let utcMs = baseUtc;
  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getOffsetMsAt(new Date(utcMs), timezone);
    utcMs = baseUtc - offsetMs;
  }

  return new Date(utcMs).toISOString();
}

function addDays(dateStr: string, days: number) {
  const [year, month, day] = dateStr.split("-").map(value => Number.parseInt(value, 10));
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function parseSlotTimes(input: unknown) {
  const raw = Array.isArray(input)
    ? input.map(value => String(value || "").trim())
    : String(input || "")
        .split(",")
        .map(value => value.trim());
  const valid = raw.filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  return valid.length ? valid : [...DEFAULT_SLOTS];
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
  if (!job.start_date) throw new Error("job_start_date_required");

  const project = pickProjectConfig((job as JobScheduleContext).projects);
  const timezone = String(project.timezone || "Europe/Zurich");
  const slotTimes = parseSlotTimes(project.slot_times);

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
