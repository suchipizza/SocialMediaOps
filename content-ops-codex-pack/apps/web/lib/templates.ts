import JSZip from "jszip";
import { createHash, randomUUID } from "node:crypto";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "./supabase";
import { validateManifest } from "./manifest";
import { generateTemplatePreview } from "./template-preview";

const ALLOWED_PLATFORM_SCOPES = new Set(["instagram", "tiktok", "both"]);
const TEMPLATE_FORMATS = ["A", "B", "C"] as const;
type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

function normalizeZipEntries(zip: JSZip) {
  const fileEntries = Object.values(zip.files).filter(entry => !entry.dir);
  const filtered = fileEntries.filter(entry => !entry.name.startsWith("__MACOSX/") && !entry.name.includes("/._"));

  const parts = filtered.map(entry => entry.name.split("/").filter(Boolean));
  const firstSegments = parts.map(p => p[0]).filter(Boolean);
  const allSameRoot = firstSegments.length > 0 && firstSegments.every(seg => seg === firstSegments[0]);

  const entries = new Map<string, JSZip.JSZipObject>();
  for (const entry of filtered) {
    const normalized = allSameRoot ? entry.name.split("/").slice(1).join("/") : entry.name;
    if (!normalized) continue;
    entries.set(normalized, entry);
  }
  return entries;
}

function hasEntry(entries: Map<string, JSZip.JSZipObject>, name: string) {
  return entries.has(name) || entries.has(name.replace(/^\.\//, ""));
}

function detectTemplateFormat(entries: Map<string, JSZip.JSZipObject>): TemplateFormat | null {
  const hasManifest = Array.from(entries.keys()).some(k => k.toLowerCase().endsWith("manifest.json"));
  const hasTemplateHtml = hasEntry(entries, "template.html");
  const hasBackgrounds = Array.from(entries.keys()).some(k => k.startsWith("backgrounds/"));
  const hasPackage = hasEntry(entries, "package.json");
  const hasVite = hasEntry(entries, "vite.config.ts") || hasEntry(entries, "vite.config.js");
  const hasApp = hasEntry(entries, "src/App.tsx");

  if (hasTemplateHtml && hasManifest) return "A";
  if (hasBackgrounds && hasManifest) return "B";
  if (hasPackage && hasVite && hasApp) return "C";
  return null;
}

function findManifestEntry(entries: Map<string, JSZip.JSZipObject>) {
  const candidates = Array.from(entries.entries())
    .filter(([name]) => name.toLowerCase().endsWith("manifest.json"))
    .map(([, entry]) => entry);

  if (!candidates.length) return null;
  return candidates
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.length - b.name.length)
    .at(0) ?? null;
}

function buildDefaultFormatCManifest() {
  return {
    template_format: "react-vite-v1",
    template_version: "1.0",
    output: { width: 1080, height: 1350, format: "jpeg", quality: 90 },
    slide_count: 10,
    render: { mode: "querystring", query: { slide: "slide", data: "data" }, capture: "auto" }
  };
}

export async function createTemplateFromZip(params: {
  name: string;
  platformScope?: string;
  file: File;
}) {
  const name = params.name.trim();
  if (!name) {
    throw new Error("name_required");
  }

  const platformScope = (params.platformScope || "both").toLowerCase();
  if (!ALLOWED_PLATFORM_SCOPES.has(platformScope)) {
    throw new Error("invalid_platform_scope");
  }

  const arrayBuffer = await params.file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const zip = await JSZip.loadAsync(buffer);
  const entries = normalizeZipEntries(zip);
  const templateFormat = detectTemplateFormat(entries);
  if (!templateFormat) {
    throw new Error("template_format_unknown");
  }

  const manifestEntry = findManifestEntry(entries);

  let manifestJson: unknown;
  if (manifestEntry) {
    try {
      const manifestRaw = await manifestEntry.async("string");
      manifestJson = JSON.parse(manifestRaw);
    } catch (err) {
      throw new Error("manifest_invalid_json");
    }
  } else if (templateFormat === "C") {
    manifestJson = buildDefaultFormatCManifest();
  } else {
    throw new Error("manifest_missing");
  }

  let manifest: any;
  try {
    manifest = validateManifest(manifestJson);
  } catch (err: any) {
    const zodMessage =
      err?.issues?.length ? err.issues.map((i: any) => `${i.path?.join(".") || "root"}: ${i.message}`).join("; ") : null;
    throw new Error(`manifest_invalid_schema:${zodMessage || err?.message || "unknown"}`);
  }

  const supabase = createSupabaseServerClient();
  const bucket = getSupabaseStorageBucket();
  const storagePath = `template-packs/${randomUUID()}.zip`;
  const templateHash = createHash("sha256").update(buffer).digest("hex");

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: params.file.type || "application/zip",
      upsert: false
    });
  if (uploadError) {
    throw new Error(`storage_upload_failed:${uploadError.message}`);
  }

  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  const templatePackUrl = publicData.publicUrl;

  const { data, error } = await supabase
    .from("templates")
    .insert({
      name,
      platform_scope: platformScope,
      template_pack_url: templatePackUrl,
      manifest_json: manifest,
      format: templateFormat,
      status: "PROCESSING",
      template_hash: templateHash
    })
    .select()
    .single();

  if (error) {
    throw new Error(`db_insert_failed:${error.message}`);
  }

  if (data?.id) {
    try {
      const previewAssets = await generateTemplatePreview({
        templateId: data.id,
        templateHash,
        templateFormat,
        manifest,
        zip
      });

      await supabase
        .from("templates")
        .update({
          preview_assets: previewAssets,
          manifest_json: manifest,
          status: "VALID",
          preview_error: null,
          preview_generated_at: new Date().toISOString()
        })
        .eq("id", data.id);
      data.preview_assets = previewAssets;
      data.status = "VALID";
    } catch (err: any) {
      await supabase
        .from("templates")
        .update({
          status: "INVALID_RENDER",
          preview_error: err?.message || String(err),
          preview_generated_at: new Date().toISOString()
        })
        .eq("id", data.id);
      data.status = "INVALID_RENDER";
      data.preview_error = err?.message || String(err);
    }
  }

  return data;
}
