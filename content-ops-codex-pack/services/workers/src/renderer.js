import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import { renderFormatCSlides } from "../../renderer/src/format-c.js";
import { enqueuePublishJobsForPost } from "./lib/publish-jobs.js";

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
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "content-ops";
const batchSize = Number.parseInt(process.env.RENDER_BATCH_SIZE || "3", 10);
const maxBatches = Number.parseInt(process.env.RENDER_MAX_BATCHES || "0", 10);

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function fetchTemplate(templateId) {
  const { data, error } = await supabase
    .from("templates")
    .select("id,format,template_pack_url,manifest_json,template_hash,status")
    .eq("id", templateId)
    .single();
  if (error || !data?.id) throw new Error(`template_not_found:${templateId}`);
  if (data.status === "INVALID_RENDER") throw new Error(`template_invalid_render:${templateId}`);
  return data;
}

async function fetchPostPayloads(postId) {
  const { data: slides, error } = await supabase
    .from("slides")
    .select("slide_index,fields")
    .eq("post_id", postId)
    .order("slide_index", { ascending: true });
  if (error) throw new Error(`slides_fetch_failed:${error.message}`);
  return slides || [];
}

async function uploadRenderedSlides({ postId, templateHash, output, buffers }) {
  const format = output?.format === "png" ? "png" : "jpeg";
  const ext = format === "png" ? "png" : "jpg";
  const mime = format === "png" ? "image/png" : "image/jpeg";

  const assets = [];
  for (let i = 0; i < buffers.length; i += 1) {
    const slideIndex = i + 1;
    const buffer = buffers[i];
    const storagePath = `renders/${postId}/${templateHash}/slide_${String(slideIndex).padStart(2, "0")}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, buffer, {
        contentType: mime,
        upsert: true
      });
    if (uploadError) throw new Error(`upload_failed:${uploadError.message}`);
    const { data: publicUrl } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);

    assets.push({
      post_id: postId,
      slide_index: slideIndex,
      image_url: publicUrl.publicUrl,
      width: output.width,
      height: output.height,
      bytes: buffer.length,
      mime
    });
  }

  const { error: assetsError } = await supabase
    .from("assets")
    .upsert(assets, { onConflict: "post_id,slide_index" });
  if (assetsError) throw new Error(`assets_upsert_failed:${assetsError.message}`);
}

async function renderPost(post) {
  const templateId = post.template_id || post.jobs?.template_id;
  if (!templateId) throw new Error("post_template_missing");

  const template = await fetchTemplate(templateId);
  if (template.format !== "C") throw new Error(`template_format_not_supported:${template.format}`);

  const slides = await fetchPostPayloads(post.id);
  if (!slides.length) throw new Error("slides_missing");

  const slideCount = post.slide_count || slides.length;
  const payloads = slides.map(slide => ({
    slide_index: slide.slide_index,
    slide_count: slideCount,
    fields: slide.fields || {}
  }));

  const res = await fetch(template.template_pack_url);
  if (!res.ok) throw new Error(`template_pack_fetch_failed:${res.status}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  const { buffers, output, templateHash } = await renderFormatCSlides({
    manifest: template.manifest_json,
    zipBuffer,
    payloads
  });

  const finalHash = template.template_hash || templateHash || createHash("sha256").update(zipBuffer).digest("hex");
  await uploadRenderedSlides({ postId: post.id, templateHash: finalHash, output, buffers });

  await supabase
    .from("posts")
    .update({ status: "RENDERED", error_code: null, error_message: null })
    .eq("id", post.id);
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "RENDER_SUCCESS",
    payload: { template_id: template.id, slide_count: slideCount }
  });

  try {
    const publishQueueResult = await enqueuePublishJobsForPost({
      supabase,
      post: {
        id: post.id,
        project_id: post.project_id,
        job_id: post.job_id || null,
        publish_platforms: post.publish_platforms,
        scheduled_at: post.scheduled_at || null
      }
    });

    await supabase.from("events_log").insert({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      type: "PUBLISH_JOBS_ENQUEUED",
      payload: publishQueueResult
    });
  } catch (queueError) {
    await supabase.from("events_log").insert({
      project_id: post.project_id,
      job_id: post.job_id || null,
      post_id: post.id,
      type: "PUBLISH_JOBS_ENQUEUE_FAILED",
      payload: { message: String(queueError?.message || queueError) }
    });
  }
}

async function markFailed(post, err) {
  const message = String(err?.message || err);
  await supabase
    .from("posts")
    .update({ status: "FAILED", error_code: "RENDER_FAILED", error_message: message })
    .eq("id", post.id);
  await supabase.from("events_log").insert({
    project_id: post.project_id,
    job_id: post.job_id || null,
    post_id: post.id,
    type: "RENDER_FAILED",
    payload: { message }
  });
}

async function processApprovedBatch() {
  const { data: posts, error } = await supabase
    .from("posts")
    .select("id,project_id,job_id,slide_count,template_id,publish_platforms,scheduled_at,projects(id),jobs(template_id)")
    .eq("status", "APPROVED")
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(`posts_fetch_failed:${error.message}`);

  let rendered = 0;
  let failed = 0;
  for (const post of posts || []) {
    try {
      await renderPost(post);
      rendered += 1;
    } catch (err) {
      await markFailed(post, err);
      failed += 1;
    }
  }

  return { fetched: (posts || []).length, rendered, failed };
}

async function runUntilDrained() {
  let batches = 0;
  let totalFetched = 0;
  let totalRendered = 0;
  let totalFailed = 0;

  while (true) {
    if (maxBatches > 0 && batches >= maxBatches) break;
    const batch = await processApprovedBatch();
    batches += 1;
    totalFetched += batch.fetched;
    totalRendered += batch.rendered;
    totalFailed += batch.failed;
    if (batch.fetched === 0) break;
  }

  return { batches, totalFetched, totalRendered, totalFailed };
}

runUntilDrained()
  .then(summary => {
    console.log(
      `Renderer worker finished. batches=${summary.batches} fetched=${summary.totalFetched} rendered=${summary.totalRendered} failed=${summary.totalFailed}`
    );
    process.exit(0);
  })
  .catch(err => {
    console.error("Renderer worker failed:", err);
    process.exit(1);
  });
