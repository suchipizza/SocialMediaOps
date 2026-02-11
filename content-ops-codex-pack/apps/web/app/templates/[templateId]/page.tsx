import { notFound, redirect } from "next/navigation";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { createSupabaseServerClient } from "../../../lib/supabase";
import { generateTemplatePreview } from "../../../lib/template-preview";

export const dynamic = "force-dynamic";

async function rebuildPreview(formData: FormData) {
  "use server";
  const templateId = String(formData.get("template_id") || "").trim();
  if (!templateId) return;

  const supabase = createSupabaseServerClient();
  const { data: template, error } = await supabase
    .from("templates")
    .select("id,format,template_pack_url,manifest_json")
    .eq("id", templateId)
    .single();
  if (error || !template?.template_pack_url) {
    redirect(`/templates/${templateId}?error=${encodeURIComponent(error?.message || "template_not_found")}`);
  }

  try {
    const res = await fetch(template.template_pack_url);
    if (!res.ok) throw new Error(`template_pack_fetch_failed:${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const templateHash = createHash("sha256").update(buf).digest("hex");
    const previewAssets = await generateTemplatePreview({
      templateId: template.id,
      templateHash,
      templateFormat: template.format || "A",
      manifest: template.manifest_json,
      zip
    });

    await supabase
      .from("templates")
      .update({
        preview_assets: previewAssets,
        status: "VALID",
        preview_error: null,
        preview_generated_at: new Date().toISOString(),
        template_hash: templateHash
      })
      .eq("id", template.id);

    redirect(`/templates/${templateId}?rebuilt=1`);
  } catch (err: any) {
    if (err?.digest?.startsWith("NEXT_REDIRECT")) {
      throw err;
    }
    await supabase
      .from("templates")
      .update({
        status: "INVALID_RENDER",
        preview_error: err?.message || String(err),
        preview_generated_at: new Date().toISOString()
      })
      .eq("id", template.id);
    redirect(`/templates/${templateId}?error=${encodeURIComponent(err?.message || "preview_failed")}`);
  }
}

export default async function TemplatePreviewPage({
  params
  , searchParams
}: {
  params: Promise<{ templateId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { templateId } = await params;
  const query = (await searchParams) || {};
  const errorParam = Array.isArray(query.error) ? query.error[0] : query.error;
  const rebuilt = Array.isArray(query.rebuilt) ? query.rebuilt[0] : query.rebuilt;
  const supabase = createSupabaseServerClient();
  const { data: template, error } = await supabase
    .from("templates")
    .select("id,name,format,status,preview_assets,preview_error,manifest_json")
    .eq("id", templateId)
    .single();
  if (error || !template) notFound();

  const previewAssets = (template.preview_assets || []) as any[];
  const output = template.manifest_json?.output;
  const sizeLabel = output ? `${output.width}×${output.height}` : "1080×1350";

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Template preview</h1>
          <p className="page-subtitle">
            {template.name} • <span className="chip">{template.format}</span> •{" "}
            <span className="chip">{template.status}</span>
          </p>
        </div>
        <div>
          <a className="chip" href="/templates">
            Back to templates
          </a>
        </div>
      </div>

      {rebuilt ? (
        <div className="card" style={{ borderColor: "rgba(34, 140, 34, 0.4)" }}>
          <h3>Preview rebuilt</h3>
          <p>The preview assets were regenerated.</p>
        </div>
      ) : null}

      {errorParam ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Rebuild failed</h3>
          <p>{errorParam}</p>
        </div>
      ) : null}

      {template.preview_error ? (
        <div className="card" style={{ borderColor: "rgba(240, 108, 0, 0.5)" }}>
          <h3>Preview failed</h3>
          <p>{template.preview_error}</p>
        </div>
      ) : null}

      <div className="card">
        <h3>Rebuild preview</h3>
        <form action={rebuildPreview}>
          <input type="hidden" name="template_id" value={templateId} />
          <button type="submit">Rebuild preview</button>
        </form>
      </div>

      {!previewAssets.length ? (
        <div className="empty">Preview images not available yet.</div>
      ) : (
        <div className="card-grid">
          {previewAssets.map((asset: any) => (
            <div className="card" key={asset.slide_index}>
              <h3>
                Slide {asset.slide_index} <span className="chip">{sizeLabel}</span>
              </h3>
              <div
                style={{
                  width: "100%",
                  aspectRatio: "4 / 5",
                  borderRadius: 16,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  background: "#000"
                }}
              >
                <img src={asset.url} alt={`Slide ${asset.slide_index}`} style={{ width: "100%" }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
