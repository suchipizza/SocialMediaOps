import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "../../../../lib/supabase";
import { renderFormatCPostSlides } from "../../../../lib/template-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function normalizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

async function readFileIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

function extractStoragePath(url: string | null | undefined, bucket: string) {
  if (!url) return null;
  try {
    if (!url.includes("://")) {
      return url.replace(/^\/+/, "");
    }
    const parsed = new URL(url);
    const pathName = parsed.pathname;
    const publicMarker = `/storage/v1/object/public/${bucket}/`;
    const signedMarker = `/storage/v1/object/sign/${bucket}/`;
    if (pathName.includes(publicMarker)) {
      const rawPath = pathName.split(publicMarker)[1]?.replace(/^\/+/, "") || "";
      return decodeURIComponent(rawPath);
    }
    if (pathName.includes(signedMarker)) {
      const rawPath = pathName.split(signedMarker)[1]?.replace(/^\/+/, "") || "";
      return decodeURIComponent(rawPath);
    }
  } catch {
    return null;
  }
  return null;
}

function toErrorImage(message: string) {
  const safe = message.replace(/[<>&]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch] || ch));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="#0d1117"/><g fill="#f0f6fc"><text x="64" y="120" font-family="Inter, Arial, sans-serif" font-size="40" font-weight="700">Preview Error</text><text x="64" y="190" font-family="Inter, Arial, sans-serif" font-size="28">${safe}</text></g></svg>`;
  return new NextResponse(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-preview-error": message
    }
  });
}

async function fetchTemplateZip(params: {
  templatePackUrl: string;
  supabase: ReturnType<typeof createSupabaseServerClient>;
}) {
  const byUrl = async () => {
    try {
      const res = await fetch(params.templatePackUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const zip = await JSZip.loadAsync(buf);
      const templateHash = createHash("sha256").update(buf).digest("hex");
      return { zip, templateHash };
    } catch {
      return null;
    }
  };

  const firstTry = await byUrl();
  if (firstTry) return firstTry;

  const bucket = getSupabaseStorageBucket();
  const storagePath = extractStoragePath(params.templatePackUrl, bucket);
  if (!storagePath) return null;
  const { data, error } = await params.supabase.storage.from(bucket).download(storagePath);
  if (error || !data) return null;

  const buffer = Buffer.from(await data.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const templateHash = createHash("sha256").update(buffer).digest("hex");
  return { zip, templateHash };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const postIdRaw = url.searchParams.get("post_id");
    const slideParam = url.searchParams.get("slide");
    if (!postIdRaw) return toErrorImage("post_id_required");

    const slideIndex = Number(slideParam || "0");
    if (!Number.isFinite(slideIndex) || slideIndex < 1) return toErrorImage("slide_required");

    const postId = normalizeId(postIdRaw);
    const supabase = createSupabaseServerClient();

    const { data: post, error: postError } = await supabase
      .from("posts")
      .select("id,slide_count,pillar_id,template_id,job_id,jobs(template_id)")
      .eq("id", postIdRaw)
      .single();
    if (postError || !post) return toErrorImage("post_not_found");

    const { data: pillar } = await supabase
      .from("pillars")
      .select("id,template_id")
      .eq("id", post.pillar_id)
      .single();

    const jobTemplateId = Array.isArray(post.jobs) ? post.jobs[0]?.template_id : (post.jobs as any)?.template_id;
    const preferredTemplateId = post.template_id || jobTemplateId || pillar?.template_id;
    if (!preferredTemplateId) return toErrorImage("template_not_assigned");

    const { data: template, error: templateError } = await supabase
      .from("templates")
      .select("id,format,template_pack_url,manifest_json,template_hash,status")
      .eq("id", preferredTemplateId)
      .single();

    if (templateError || !template?.id) return toErrorImage("template_not_found");
    if (template.format !== "C") return toErrorImage("template_format_not_supported");
    if (!template.template_pack_url || !template.manifest_json) return toErrorImage("template_pack_missing");

    const { data: slides } = await supabase
      .from("slides")
      .select("slide_index,fields")
      .eq("post_id", postIdRaw)
      .order("slide_index", { ascending: true });

    const slideCount = post.slide_count || slides?.length || 0;
    if (!slideCount) return toErrorImage("slides_missing");
    if (slideIndex > slideCount) return toErrorImage("slide_out_of_range");

    const payloads = (slides || []).map((slide: any) => ({
      slide_index: slide.slide_index,
      slide_count: slideCount,
      fields: (slide.fields || {}) as Record<string, unknown>
    }));

    const output = template.manifest_json?.output;
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          renderVersion: "v20",
          templateHash: template.template_hash || template.template_pack_url,
          payloads,
          output
        })
      )
      .digest("hex");
    const safeHash = payloadHash;
    const repoRoot = getRepoRoot();
    const cacheDir = path.join(repoRoot, ".cache", "queue-previews", postId, safeHash);
    const format = output?.format === "png" ? "png" : "jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const filename = `slide_${String(slideIndex).padStart(2, "0")}.${ext}`;
    const filePath = path.join(cacheDir, filename);
    const mime = format === "png" ? "image/png" : "image/jpeg";

    const cached = await readFileIfExists(filePath);
    if (cached) {
      return new NextResponse(cached, {
        headers: {
          "content-type": mime,
          "cache-control": "no-store"
        }
      });
    }

    await fs.mkdir(cacheDir, { recursive: true });

    const zipPayload = await fetchTemplateZip({
      templatePackUrl: template.template_pack_url,
      supabase
    });
    if (!zipPayload) return toErrorImage("template_pack_fetch_failed");

    const { zip, templateHash } = zipPayload;

    const buffers = await renderFormatCPostSlides({
      manifest: template.manifest_json,
      templateHash,
      zip,
      payloads
    });

    await Promise.all(
      buffers.map(async (buffer, index) => {
        const slideNumber = index + 1;
        const slideFile = path.join(cacheDir, `slide_${String(slideNumber).padStart(2, "0")}.${ext}`);
        await fs.writeFile(slideFile, buffer);
      })
    );

    const rendered = await readFileIfExists(filePath);
    if (!rendered) return toErrorImage("render_failed");

    return new NextResponse(rendered, {
      headers: {
        "content-type": mime,
        "cache-control": "no-store"
      }
    });
  } catch (err: any) {
    const message = err?.message ? String(err.message) : "preview_failed";
    console.error("[queue-preview] failed", err);
    return toErrorImage(message);
  }
}
