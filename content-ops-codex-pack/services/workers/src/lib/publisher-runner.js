import os from "node:os";
import {
  claimPublishJobs,
  markPublishJobFailed,
  markPublishJobPublished
} from "./publish-jobs.js";
import { publishInstagramCarousel } from "../platforms/instagram.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPublishPayload(job, post, assets) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags.filter(Boolean) : [];
  const caption = [String(post.caption || "").trim(), hashtags.join(" ").trim()].filter(Boolean).join("\n\n");
  const imageUrls = assets.map(asset => asset.image_url);
  return {
    platform: job.platform,
    postId: post.id,
    caption,
    imageUrls
  };
}

function isFatalPublishError(message) {
  const fatalCodes = [
    "post_not_found",
    "post_invalid_status",
    "platform_not_supported",
    "platform_not_implemented",
    "missing_platform_credentials"
  ];
  return fatalCodes.some(code => message.includes(code));
}

function maybeParseJsonString(input) {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeProjectConfig(raw) {
  if (!raw) return null;
  if (typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
  if (Buffer.isBuffer(raw)) {
    return maybeParseJsonString(raw.toString("utf8"));
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = maybeParseJsonString(trimmed);
  if (parsed) return parsed;

  if (trimmed.startsWith("\\x")) {
    const hexDecoded = Buffer.from(trimmed.slice(2), "hex").toString("utf8");
    const hexParsed = maybeParseJsonString(hexDecoded);
    if (hexParsed) return hexParsed;
  }

  const base64Decoded = Buffer.from(trimmed, "base64").toString("utf8");
  const base64Parsed = maybeParseJsonString(base64Decoded);
  if (base64Parsed) return base64Parsed;

  return null;
}

function getNestedProject(post) {
  return Array.isArray(post.projects) ? post.projects[0] : post.projects;
}

function readCredential(config, keys) {
  if (!config || typeof config !== "object") return "";
  for (const key of keys) {
    const value = config[key];
    if (value) return String(value).trim();
  }
  return "";
}

function resolveInstagramCredentials(post) {
  const project = getNestedProject(post);
  const links = Array.isArray(project?.project_social_accounts) ? project.project_social_accounts : [];
  let linkedConfig = null;
  for (const link of links) {
    const account = Array.isArray(link?.social_accounts) ? link.social_accounts[0] : link?.social_accounts;
    if (!account || account.platform !== "instagram") continue;
    linkedConfig = decodeProjectConfig(account.credentials_json);
    if (linkedConfig) break;
  }

  const projectConfig = decodeProjectConfig(project?.ig_account_config);
  const mergedConfig = linkedConfig || projectConfig;

  const accessToken =
    readCredential(mergedConfig, ["ig_access_token", "access_token", "igAccessToken", "accessToken"]) ||
    String(process.env.IG_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || "").trim();
  const userId =
    readCredential(mergedConfig, ["ig_user_id", "user_id", "igUserId", "userId"]) ||
    String(process.env.IG_USER_ID || process.env.INSTAGRAM_USER_ID || "").trim();

  return { accessToken, userId };
}

async function fetchPostWithAssets(supabase, postId) {
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,project_id,job_id,status,caption,hashtags,published_ids,projects(id,ig_account_config,project_social_accounts(account_id,social_accounts(id,platform,name,credentials_json)))")
    .eq("id", postId)
    .single();
  if (postError || !post?.id) throw new Error("post_not_found");
  if (post.status !== "RENDERED") throw new Error(`post_invalid_status:${post.status}`);

  const { data: assets, error: assetsError } = await supabase
    .from("assets")
    .select("slide_index,image_url")
    .eq("post_id", postId)
    .order("slide_index", { ascending: true });
  if (assetsError) throw new Error(`assets_fetch_failed:${assetsError.message}`);
  if (!assets?.length) throw new Error("assets_missing");

  return { post, assets };
}

async function publishForPlatform({ job, payload, post, dryRun }) {
  if (dryRun) {
    return {
      platform: job.platform,
      dry_run: true,
      external_id: `dryrun:${job.platform}:${job.post_id}:${Date.now()}`
    };
  }

  if (job.platform === "instagram") {
    const credentials = resolveInstagramCredentials(post);
    return publishInstagramCarousel({
      igAccessToken: credentials.accessToken,
      igUserId: credentials.userId,
      imageUrls: payload.imageUrls,
      caption: payload.caption
    });
  }
  if (job.platform === "tiktok") {
    throw new Error("platform_not_implemented:tiktok");
  }
  if (job.platform === "manual_export") {
    return {
      platform: "manual_export",
      dry_run: false,
      external_id: `manual:${job.post_id}:${Date.now()}`,
      image_count: payload.imageUrls.length
    };
  }

  throw new Error(`platform_not_supported:${job.platform}`);
}

async function markPostPublishedIds(supabase, post, platform, publishedInfo) {
  const current = post.published_ids && typeof post.published_ids === "object" ? post.published_ids : {};
  const merged = { ...current, [platform]: publishedInfo };
  const { error } = await supabase.from("posts").update({ published_ids: merged }).eq("id", post.id);
  if (error) {
    throw new Error(`post_published_ids_update_failed:${error.message}`);
  }
}

async function handlePublishJob({ supabase, publishJob, dryRun }) {
  const { post, assets } = await fetchPostWithAssets(supabase, publishJob.post_id);
  const payload = buildPublishPayload(publishJob, post, assets);
  const publishedInfo = await publishForPlatform({
    job: publishJob,
    payload,
    post,
    dryRun
  });

  await markPublishJobPublished({
    supabase,
    publishJobId: publishJob.id,
    publishedIds: publishedInfo
  });
  await markPostPublishedIds(supabase, post, publishJob.platform, publishedInfo);
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "PUBLISH_SUCCESS",
    payload: {
      publish_job_id: publishJob.id,
      platform: publishJob.platform,
      published: publishedInfo
    }
  });
}

async function handlePublishError({ supabase, publishJob, err }) {
  const message = String(err?.message || err || "publish_failed");
  const rawCode = String(err?.code || "").trim();
  const errorCode = (rawCode || message.split(":")[0] || "PUBLISH_FAILED").toUpperCase();
  const retryable = typeof err?.retryable === "boolean" ? err.retryable : null;
  const forceFinal = retryable === false || isFatalPublishError(message) || isFatalPublishError(rawCode);

  await markPublishJobFailed({
    supabase,
    publishJob,
    errorCode,
    errorMessage: message,
    forceFinal
  });

  await supabase.from("events_log").insert({
    project_id: publishJob.project_id,
    job_id: publishJob.job_id || null,
    post_id: publishJob.post_id,
    type: "PUBLISH_FAILED",
    payload: {
      publish_job_id: publishJob.id,
      platform: publishJob.platform,
      error_code: errorCode,
      message,
      force_final: forceFinal,
      retryable
    }
  });
}

export function defaultPublishWorkerId() {
  return process.env.PUBLISH_WORKER_ID || `${os.hostname()}:${process.pid}`;
}

export function resolveDryRun() {
  return String(process.env.PUBLISH_DRY_RUN || "true").toLowerCase() !== "false";
}

export async function runPublisherOnce({
  supabase,
  workerId = defaultPublishWorkerId(),
  dryRun = resolveDryRun(),
  logger = console
}) {
  const claimed = await claimPublishJobs({
    supabase,
    workerId
  });

  if (!claimed.length) {
    logger.log("Publisher worker finished. No publish jobs claimed.");
    return { claimed: 0, processed: 0, published: 0, failed: 0 };
  }

  let published = 0;
  let failed = 0;
  for (const publishJob of claimed) {
    try {
      await handlePublishJob({ supabase, publishJob, dryRun });
      published += 1;
    } catch (err) {
      await handlePublishError({ supabase, publishJob, err });
      failed += 1;
    }
  }

  logger.log(`Publisher worker finished. Processed ${claimed.length} publish job(s).`);
  return {
    claimed: claimed.length,
    processed: claimed.length,
    published,
    failed
  };
}

export async function runPublisherLoop({
  supabase,
  workerId = defaultPublishWorkerId(),
  dryRun = resolveDryRun(),
  pollIntervalMs = Number.parseInt(process.env.PUBLISH_LOOP_POLL_MS || "15000", 10),
  maxIterations = Number.parseInt(process.env.PUBLISH_LOOP_MAX_ITERATIONS || "0", 10),
  logger = console
}) {
  const summary = { iterations: 0, claimed: 0, processed: 0, published: 0, failed: 0 };
  while (true) {
    if (maxIterations > 0 && summary.iterations >= maxIterations) break;
    const cycle = await runPublisherOnce({ supabase, workerId, dryRun, logger });
    summary.iterations += 1;
    summary.claimed += cycle.claimed;
    summary.processed += cycle.processed;
    summary.published += cycle.published;
    summary.failed += cycle.failed;
    await sleep(Math.max(pollIntervalMs, 1000));
  }
  return summary;
}

