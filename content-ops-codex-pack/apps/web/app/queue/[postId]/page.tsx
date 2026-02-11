import { notFound } from "next/navigation";
import { createHash } from "node:crypto";
import { createSupabaseServerClient } from "../../../lib/supabase";
import { buildSlidePreviewHtml } from "../../../lib/template-pack";

export const dynamic = "force-dynamic";

function buildPlaceholders(params: {
  slideFields: Record<string, unknown>;
  slideIndex: number;
  slideCount: number;
}) {
  return {
    headline: params.slideFields.headline ?? "",
    body: params.slideFields.body ?? "",
    footer: params.slideFields.footer ?? "",
    page_number: params.slideFields.page_number ?? `${params.slideIndex}/${params.slideCount}`
  };
}

export default async function QueuePostPreviewPage({
  params
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  const supabase = createSupabaseServerClient();

  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,status,slide_count,pillar_id,template_id,jobs(id,template_id),projects(id)")
    .eq("id", postId)
    .single();
  if (postError || !post) notFound();

  const { data: pillar } = await supabase
    .from("pillars")
    .select("id,name,template_id")
    .eq("id", post.pillar_id)
    .single();
  if (!pillar?.template_id) notFound();

  const jobTemplateId = Array.isArray(post.jobs) ? post.jobs[0]?.template_id : post.jobs?.template_id;
  const preferredTemplateId = post.template_id || jobTemplateId || pillar.template_id;

  let { data: template } = await supabase
    .from("templates")
    .select("id,format,template_pack_url,manifest_json,template_hash")
    .eq("id", preferredTemplateId)
    .single();

  const templateMissing =
    !template?.id ||
    (template.format === "C" && (!template.template_pack_url || !template.manifest_json));

  if (templateMissing) {
    const { data: fallback } = await supabase
      .from("templates")
      .select("id,format,template_pack_url,manifest_json,template_hash")
      .eq("status", "VALID")
      .in("format", ["A", "C"])
      .order("created_at", { ascending: false })
      .limit(1);

    template = fallback?.[0] || null;
    if (template?.id && template.id !== pillar.template_id) {
      await supabase.from("pillars").update({ template_id: template.id }).eq("id", pillar.id);
    }
  }

  if (!template?.id) notFound();

  if (template.format && template.format !== "A" && template.format !== "C") {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>Carousel preview</h1>
            <p className="page-subtitle">
              Post <span className="chip">{post.status}</span> • Pillar{" "}
              <span className="chip">{pillar.name}</span>
            </p>
          </div>
          <div>
            <a className="chip" href="/queue">
              Back to queue
            </a>
          </div>
        </div>
        <div className="card">
          <h3>Preview not available yet</h3>
          <p>This post uses a Format {template.format} template. Queue preview currently supports Format A and C.</p>
          <p>
            Use the template preview for layout checks, or switch to a Format A template for inline review.
          </p>
        </div>
      </div>
    );
  }

  const { data: slides } = await supabase
    .from("slides")
    .select("slide_index,fields")
    .eq("post_id", postId)
    .order("slide_index", { ascending: true });

  const slideCount = post.slide_count || slides?.length || 0;

  if (template.format === "C") {
    if (!template.template_pack_url || !template.manifest_json) {
      return (
        <div>
          <div className="page-header">
            <div>
              <h1>Carousel preview</h1>
              <p className="page-subtitle">
                Post <span className="chip">{post.status}</span> • Pillar{" "}
                <span className="chip">{pillar.name}</span>
              </p>
            </div>
            <div>
              <a className="chip" href="/queue">
                Back to queue
              </a>
            </div>
          </div>
          <div className="card">
            <h3>Preview not available</h3>
            <p>Template pack or manifest is missing for this Format C template.</p>
          </div>
        </div>
      );
    }

    const payloads = (slides || []).map((slide: any) => ({
      slide_index: slide.slide_index,
      slide_count: slideCount,
      fields: (slide.fields || {}) as Record<string, unknown>
    }));
    const output = template.manifest_json?.output;
    const sizeLabel = output ? `${output.width}×${output.height}` : "1080×1350";
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

    return (
      <div>
        <div className="page-header">
          <div>
            <h1>Carousel preview</h1>
            <p className="page-subtitle">
              Post <span className="chip">{post.status}</span> • Pillar{" "}
              <span className="chip">{pillar.name}</span>
            </p>
          </div>
          <div>
            <a className="chip" href="/queue">
              Back to queue
            </a>
          </div>
        </div>

        {!payloads.length ? (
          <div className="empty">No slides found for this post.</div>
        ) : (
          <div className="card-grid">
            {payloads.map((payload) => (
              <div className="card" key={payload.slide_index}>
                <h3>
                  Slide {payload.slide_index} <span className="chip">{sizeLabel}</span>
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
                  <img
                    src={`/api/queue/preview?post_id=${encodeURIComponent(postId)}&slide=${payload.slide_index}&hash=${payloadHash}`}
                    alt={`Slide ${payload.slide_index}`}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const slideHtml = await Promise.all(
    (slides || []).map(async (slide: any) => {
      const placeholders = buildPlaceholders({
        slideFields: (slide.fields || {}) as Record<string, unknown>,
        slideIndex: slide.slide_index,
        slideCount
      });

      return buildSlidePreviewHtml({
        templateId: pillar.template_id,
        placeholders
      });
    })
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Carousel preview</h1>
          <p className="page-subtitle">
            Post <span className="chip">{post.status}</span> • Pillar{" "}
            <span className="chip">{pillar.name}</span>
          </p>
        </div>
        <div>
          <a className="chip" href="/queue">
            Back to queue
          </a>
        </div>
      </div>

      {!slideHtml.length ? (
        <div className="empty">No slides found for this post.</div>
      ) : (
        <div className="card-grid">
          {slideHtml.map((html, index) => (
            <div className="card" key={index}>
              <h3>
                Slide {index + 1} <span className="chip">1080×1350</span>
              </h3>
              <div style={{ width: "100%", aspectRatio: "4 / 5", borderRadius: 16, overflow: "hidden", border: "1px solid var(--border)", background: "#000" }}>
                <iframe
                  title={`slide-${index + 1}`}
                  srcDoc={html}
                  style={{
                    width: 1080,
                    height: 1350,
                    transform: "scale(0.33)",
                    transformOrigin: "top left",
                    border: 0
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
