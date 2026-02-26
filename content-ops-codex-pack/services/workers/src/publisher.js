import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import {
  claimPublishJobs,
  markPublishJobFailed,
  markPublishJobPublished
} from "./lib/publish-jobs.js";
import { publishInstagramCarousel } from "./platforms/instagram.js";

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}services${path.sep}workers`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

dotenv.config({ path: process.env.DOTENV_PATH || path.join(getRepoRoot(), ".env") });

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dryRun = String(process.env.PUBLISH_DRY_RUN || "true").toLowerCase() !== "false";
const workerId = process.env.PUBLISH_WORKER_ID || `${os.hostname()}:${process.pid}`;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

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

async function fetchPostWithAssets(postId) {
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

async function publishForPlatform(job, payload, post) {
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

async function markPostPublishedIds(post, platform, publishedInfo) {
  const current = post.published_ids && typeof post.published_ids === "object" ? post.published_ids : {};
  const merged = { ...current, [platform]: publishedInfo };
  const { error } = await supabase.from("posts").update({ published_ids: merged }).eq("id", post.id);
  if (error) {
    throw new Error(`post_published_ids_update_failed:${error.message}`);
  }
}

async function handlePublishJob(job) {
  const { post, assets } = await fetchPostWithAssets(job.post_id);
  const payload = buildPublishPayload(job, post, assets);
  const publishedInfo = await publishForPlatform(job, payload, post);

  await markPublishJobPublished({
    supabase,
    publishJobId: job.id,
    publishedIds: publishedInfo
  });
  await markPostPublishedIds(post, job.platform, publishedInfo);
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "PUBLISH_SUCCESS",
    payload: {
      publish_job_id: job.id,
      platform: job.platform,
      published: publishedInfo
    }
  });
}

async function handlePublishError(job, err) {
  const message = String(err?.message || err || "publish_failed");
  const rawCode = String(err?.code || "").trim();
  const errorCode = (rawCode || message.split(":")[0] || "PUBLISH_FAILED").toUpperCase();
  const retryable = typeof err?.retryable === "boolean" ? err.retryable : null;
  const forceFinal = retryable === false || isFatalPublishError(message) || isFatalPublishError(rawCode);

  await markPublishJobFailed({
    supabase,
    publishJob: job,
    errorCode,
    errorMessage: message,
    forceFinal
  });

  await supabase.from("events_log").insert({
    project_id: job.project_id,
    job_id: job.job_id || null,
    post_id: job.post_id,
    type: "PUBLISH_FAILED",
    payload: {
      publish_job_id: job.id,
      platform: job.platform,
      error_code: errorCode,
      message,
      force_final: forceFinal,
      retryable
    }
  });
}

async function runOnce() {
  const claimed = await claimPublishJobs({
    supabase,
    workerId
  });

  if (!claimed.length) {
    console.log("Publisher worker finished. No publish jobs claimed.");
    return;
  }

  for (const publishJob of claimed) {
    try {
      await handlePublishJob(publishJob);
    } catch (err) {
      await handlePublishError(publishJob, err);
    }
  }

  console.log(`Publisher worker finished. Processed ${claimed.length} publish job(s).`);
}

runOnce()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Publisher worker failed:", err);
    process.exit(1);
  });
