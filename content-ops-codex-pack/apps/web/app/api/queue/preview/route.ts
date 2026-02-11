import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { createSupabaseServerClient } from "../../../../lib/supabase";
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const postIdRaw = url.searchParams.get("post_id");
  const slideParam = url.searchParams.get("slide");
  const hashParam = url.searchParams.get("hash") || "";

  if (!postIdRaw) {
    return new NextResponse("post_id_required", { status: 400 });
  }

  const slideIndex = Number(slideParam || "0");
  if (!Number.isFinite(slideIndex) || slideIndex < 1) {
    return new NextResponse("slide_required", { status: 400 });
  }

  const postId = normalizeId(postIdRaw);
  const supabase = createSupabaseServerClient();

  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,slide_count,pillar_id,template_id,job_id,jobs(template_id)")
    .eq("id", postIdRaw)
    .single();
  if (postError || !post) {
    return new NextResponse("post_not_found", { status: 404 });
  }

  const { data: pillar, error: pillarError } = await supabase
    .from("pillars")
    .select("id,template_id")
    .eq("id", post.pillar_id)
    .single();
  if (pillarError || !pillar?.template_id) {
    return new NextResponse("pillar_not_found", { status: 404 });
  }

  const jobTemplateId = Array.isArray(post.jobs) ? post.jobs[0]?.template_id : post.jobs?.template_id;
  const preferredTemplateId = post.template_id || jobTemplateId || pillar.template_id;

  let { data: template, error: templateError } = await supabase
    .from("templates")
    .select("id,format,template_pack_url,manifest_json,template_hash,status")
    .eq("id", preferredTemplateId)
    .single();

  const templateMissing =
    !!templateError ||
    !template?.id ||
    template.format !== "C" ||
    !template.template_pack_url ||
    !template.manifest_json;

  if (templateMissing) {
    const { data: fallback } = await supabase
      .from("templates")
      .select("id,format,template_pack_url,manifest_json,template_hash,status")
      .eq("status", "VALID")
      .eq("format", "C")
      .order("created_at", { ascending: false })
      .limit(1);
    template = fallback?.[0] || null;
    if (template?.id && template.id !== pillar.template_id) {
      await supabase.from("pillars").update({ template_id: template.id }).eq("id", pillar.id);
    }
  }

  if (!template?.id) {
    return new NextResponse("template_not_found", { status: 404 });
  }
  if (template.format !== "C") {
    return new NextResponse("template_format_not_supported", { status: 400 });
  }
  if (!template.template_pack_url || !template.manifest_json) {
    return new NextResponse("template_pack_missing", { status: 400 });
  }

  const { data: slides } = await supabase
    .from("slides")
    .select("slide_index,fields")
    .eq("post_id", postIdRaw)
    .order("slide_index", { ascending: true });

  const slideCount = post.slide_count || slides?.length || 0;
  if (!slideCount) {
    return new NextResponse("slides_missing", { status: 404 });
  }
  if (slideIndex > slideCount) {
    return new NextResponse("slide_out_of_range", { status: 404 });
  }

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

  const fetchTemplateZip = async (templatePackUrl: string) => {
    const res = await fetch(templatePackUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const templateHash = createHash("sha256").update(buf).digest("hex");
    return { zip, templateHash };
  };

  let zipPayload = await fetchTemplateZip(template.template_pack_url);
  if (!zipPayload) {
    const { data: fallback } = await supabase
      .from("templates")
      .select("id,format,template_pack_url,manifest_json,template_hash,status")
      .eq("status", "VALID")
      .eq("format", "C")
      .order("created_at", { ascending: false })
      .limit(1);
    const fallbackTemplate = fallback?.[0];
    if (!fallbackTemplate?.template_pack_url || !fallbackTemplate?.manifest_json) {
      return new NextResponse("template_pack_fetch_failed", { status: 502 });
    }
    const fallbackZip = await fetchTemplateZip(fallbackTemplate.template_pack_url);
    if (!fallbackZip) {
      return new NextResponse("template_pack_fetch_failed", { status: 502 });
    }
    template = fallbackTemplate;
    zipPayload = fallbackZip;
    await supabase.from("posts").update({ template_id: template.id }).eq("id", post.id);
    if (post.job_id) {
      await supabase.from("jobs").update({ template_id: template.id }).eq("id", post.job_id);
    }
    await supabase.from("pillars").update({ template_id: template.id }).eq("id", pillar.id);
  }

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
  if (!rendered) {
    return new NextResponse("render_failed", { status: 500 });
  }

  return new NextResponse(rendered, {
    headers: {
      "content-type": mime,
      "cache-control": "no-store"
    }
  });
}
