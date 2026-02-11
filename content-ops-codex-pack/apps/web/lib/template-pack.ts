import JSZip from "jszip";
import { createSupabaseServerClient } from "./supabase";
import { applyPlaceholders } from "./template-subst";

type TemplatePackFiles = {
  templateHtml: string;
  stylesCss: string;
  scriptJs: string;
  entries: Map<string, JSZip.JSZipObject>;
};

const templatePackCache = new Map<string, TemplatePackFiles>();

function findEntry(entries: Map<string, JSZip.JSZipObject>, preferred: string) {
  const direct = entries.get(preferred);
  if (direct) return direct;

  const lowered = preferred.toLowerCase();
  for (const [name, entry] of entries.entries()) {
    if (name.toLowerCase() === lowered) return entry;
  }
  return null;
}

function guessContentType(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".otf")) return "font/otf";
  return "application/octet-stream";
}

function rewriteAssetUrls(params: { templateId: string; input: string }) {
  const prefix = `/api/templates/${encodeURIComponent(params.templateId)}/asset?path=`;

  // CSS url(...) references
  let out = params.input.replace(/url\((['"]?)(?!https?:|data:)([^'")]+)\1\)/g, (_m, quote, assetPath) => {
    const clean = String(assetPath).trim().replace(/^\.\//, "");
    return `url(${quote}${prefix}${encodeURIComponent(clean)}${quote})`;
  });

  // HTML src/href attributes
  out = out.replace(
    /(src|href)=("|')(?!https?:|data:|#)([^"']+)("|')/g,
    (_m, attr, q1, assetPath, q2) => {
      const clean = String(assetPath).trim().replace(/^\.\//, "");
      return `${attr}=${q1}${prefix}${encodeURIComponent(clean)}${q2}`;
    }
  );

  return out;
}

export async function loadTemplatePack(templateId: string): Promise<TemplatePackFiles> {
  const cached = templatePackCache.get(templateId);
  if (cached) return cached;

  const supabase = createSupabaseServerClient();
  const { data: template, error } = await supabase
    .from("templates")
    .select("id,template_pack_url")
    .eq("id", templateId)
    .single();
  if (error) throw new Error(`db_template_load_failed:${error.message}`);
  if (!template?.template_pack_url) throw new Error("template_pack_url_missing");

  const res = await fetch(template.template_pack_url);
  if (!res.ok) throw new Error(`template_pack_fetch_failed:${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const zip = await JSZip.loadAsync(buf);
  const fileEntries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  const filtered = fileEntries.filter(([name]) => !name.startsWith("__MACOSX/") && !name.includes("/._"));
  const parts = filtered.map(([name]) => name.split("/").filter(Boolean));
  const firstSegments = parts.map(p => p[0]).filter(Boolean);
  const allSameRoot = firstSegments.length > 0 && firstSegments.every(seg => seg === firstSegments[0]);

  const entries = new Map<string, JSZip.JSZipObject>();
  for (const [name, entry] of filtered) {
    const normalized = allSameRoot ? name.split("/").slice(1).join("/") : name;
    if (!normalized) continue;
    entries.set(normalized, entry);
  }

  const templateHtmlEntry = findEntry(entries, "template.html");
  if (!templateHtmlEntry) throw new Error("template_html_missing");

  const stylesEntry = findEntry(entries, "styles.css");
  const scriptEntry = findEntry(entries, "script.js");

  const templateHtml = await templateHtmlEntry.async("string");
  const stylesCss = stylesEntry ? await stylesEntry.async("string") : "";
  const scriptJs = scriptEntry ? await scriptEntry.async("string") : "";

  const loaded: TemplatePackFiles = { templateHtml, stylesCss, scriptJs, entries };
  templatePackCache.set(templateId, loaded);
  return loaded;
}

export async function loadTemplateAsset(params: { templateId: string; assetPath: string }) {
  const pack = await loadTemplatePack(params.templateId);
  const entry = pack.entries.get(params.assetPath) || pack.entries.get(params.assetPath.replace(/^\.\//, ""));
  if (!entry) throw new Error("asset_not_found");

  const bytes = await entry.async("nodebuffer");
  return { bytes, contentType: guessContentType(params.assetPath) };
}

export async function buildSlidePreviewHtml(params: {
  templateId: string;
  placeholders: Record<string, unknown>;
}) {
  const pack = await loadTemplatePack(params.templateId);

  const css = rewriteAssetUrls({ templateId: params.templateId, input: pack.stylesCss || "" });
  const script = rewriteAssetUrls({ templateId: params.templateId, input: pack.scriptJs || "" });
  const rawHtml = rewriteAssetUrls({ templateId: params.templateId, input: pack.templateHtml });

  const withInjected = rawHtml.replace(
    /<\/head>/i,
    `${css ? `\n<style>\n${css}\n</style>\n` : ""}${script ? `\n<script>\n${script}\n</script>\n` : ""}</head>`
  );

  const substituted = applyPlaceholders(withInjected, params.placeholders);
  return substituted;
}
