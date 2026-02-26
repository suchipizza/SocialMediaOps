import { createSupabaseServerClient } from "./supabase";
import { buildGoogleSheetCsvUrls, describeGoogleSheetLink } from "./sheets";
import { getSlideColumnIndexes, parseCsv, parseHashtags } from "./csv";

type IngestResult = {
  jobId: string;
  createdPosts: number;
  skippedRows: number;
  createdPillars: number;
};

function requireNonEmpty(value: string, errorCode: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error(errorCode);
  return trimmed;
}

function getRowValue(row: Record<string, string>, key: string) {
  if (key in row) return row[key];
  const lowered = key.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === lowered) return v;
  }
  return "";
}

function parseSlideJson(raw: string, slideIndex: number) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch (err: any) {
    throw new Error(`slide_json_invalid:${slideIndex}:${err?.message || "parse_failed"}`);
  }
  throw new Error(`slide_json_invalid:${slideIndex}:not_object`);
}

function normalizeItems(input: unknown) {
  if (!input) return undefined;
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return input
      .split("|")
      .map(part => part.trim())
      .filter(Boolean);
  }
  return undefined;
}

export async function ingestGoogleSheetToJob(params: {
  projectId: string;
  jobId: string;
  sheetUrl: string;
  templateId?: string | null;
}) : Promise<IngestResult> {
  const urls = buildGoogleSheetCsvUrls(params.sheetUrl);
  const linkKind = describeGoogleSheetLink(params.sheetUrl);

  let lastStatus: number | null = null;
  let csvText: string | null = null;
  for (const url of urls) {
    const response = await fetch(url, { redirect: "follow" });
    lastStatus = response.status;
    if (!response.ok) continue;
    csvText = await response.text();
    break;
  }

  if (!csvText) {
    if (lastStatus === 404 || lastStatus === 403) {
      throw new Error(
        `sheets_fetch_failed:${lastStatus} (${linkKind}) (make sure it is shared: “Anyone with the link can view”)`
      );
    }
    throw new Error(`sheets_fetch_failed:${lastStatus ?? "unknown"} (${linkKind})`);
  }

  const lowered = csvText.slice(0, 2000).toLowerCase();
  if (lowered.includes("<!doctype html") || lowered.includes("<html")) {
    throw new Error(`sheets_not_public (${linkKind}) (share as “Anyone with the link can view”, then retry)`);
  }
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("csv_empty");

  const headers = Object.keys(rows[0] || {});
  const slideIndexes = getSlideColumnIndexes(headers);
  if (!slideIndexes.length) throw new Error("csv_missing_slide_columns");

  const supabase = createSupabaseServerClient();
  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .select("id,platforms_enabled")
    .eq("id", params.projectId)
    .single();
  if (projectError || !projectRow?.id) {
    throw new Error(`db_project_failed:${projectError?.message || "project_not_found"}`);
  }
  const projectPlatforms =
    projectRow.platforms_enabled && typeof projectRow.platforms_enabled === "object"
      ? projectRow.platforms_enabled
      : { instagram: true, tiktok: false };

  let templateId = String(params.templateId || "").trim();
  if (templateId) {
    const { data: template, error: templateError } = await supabase
      .from("templates")
      .select("id,status")
      .eq("id", templateId)
      .single();
    if (templateError || !template?.id || template.status === "INVALID_RENDER") {
      throw new Error("job_template_not_available");
    }
  } else {
    const { data: templates, error: templatesError } = await supabase
      .from("templates")
      .select("id,status")
      .neq("status", "INVALID_RENDER")
      .order("created_at", { ascending: false })
      .limit(1);
    if (templatesError) throw new Error(`db_templates_failed:${templatesError.message}`);
    templateId = templates?.[0]?.id || "";
    if (!templateId) throw new Error("no_template_available");
  }

  const { data: existingPillars, error: pillarsError } = await supabase
    .from("pillars")
    .select("id,name,template_id")
    .eq("project_id", params.projectId);
  if (pillarsError) throw new Error(`db_pillars_failed:${pillarsError.message}`);

  const pillarByName = new Map<string, { id: string; templateId: string | null }>();
  for (const p of existingPillars || []) {
    if (p?.name) {
      pillarByName.set(String(p.name).toLowerCase(), {
        id: p.id,
        templateId: p.template_id ?? null
      });
    }
  }

  let createdPillars = 0;
  let createdPosts = 0;
  let skippedRows = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const pillarNameRaw = getRowValue(row, "pillar");
    const pillarName = String(pillarNameRaw).trim();

    if (!pillarName) {
      skippedRows += 1;
      continue;
    }

    const existingPillar = pillarByName.get(pillarName.toLowerCase());
    let pillarId = existingPillar?.id;
    if (!pillarId) {
      const { data: created, error } = await supabase
        .from("pillars")
        .insert({
          project_id: params.projectId,
          name: pillarName,
          template_id: templateId,
          default_hashtags: []
        })
        .select("id,name")
        .single();
      if (error) throw new Error(`db_create_pillar_failed:${error.message}`);
      pillarId = created.id;
      pillarByName.set(pillarName.toLowerCase(), { id: pillarId, templateId });
      createdPillars += 1;
    } else if (templateId && existingPillar && !existingPillar.templateId) {
      const { error: updateError } = await supabase
        .from("pillars")
        .update({ template_id: templateId })
        .eq("id", pillarId);
      if (!updateError) {
        existingPillar.templateId = templateId;
      }
    }

    const caption = getRowValue(row, "caption").trim() || null;
    const hashtags = parseHashtags(getRowValue(row, "hashtags"));

    const slideCount = slideIndexes.length;
    const { data: post, error: postError } = await supabase
      .from("posts")
      .insert({
        project_id: params.projectId,
        job_id: params.jobId,
        pillar_id: pillarId,
        template_id: templateId,
        status: "READY_FOR_REVIEW",
        ordering_index: rowIndex,
        slide_count: slideCount,
        caption,
        hashtags,
        publish_platforms: projectPlatforms
      })
      .select("id")
      .single();

    if (postError) {
      throw new Error(`db_create_post_failed:${postError.message}`);
    }

    const slidesPayload = slideIndexes.map(slideIndex => {
      const jsonRaw = getRowValue(row, `slide_${slideIndex}_json`);
      const parsed = parseSlideJson(jsonRaw, slideIndex);
      let fields: Record<string, unknown> = {};

      if (parsed) {
        fields = { ...parsed };
        const items = normalizeItems((parsed as any).items);
        if (items) fields.items = items;
      } else {
        const text = getRowValue(row, `slide_${slideIndex}`).trim();
        if (text) {
          fields.headline = text;
        }
      }

      if (slideIndex === slideCount) {
        fields = {};
      } else if (!("page_number" in fields)) {
        fields.page_number = `${slideIndex}/${slideCount}`;
      }

      return {
        post_id: post.id,
        slide_index: slideIndex,
        fields
      };
    });

    const { error: slidesError } = await supabase.from("slides").insert(slidesPayload);
    if (slidesError) {
      throw new Error(`db_create_slides_failed:${slidesError.message}`);
    }

    createdPosts += 1;
  }

  return {
    jobId: requireNonEmpty(params.jobId, "job_id_required"),
    createdPosts,
    skippedRows,
    createdPillars
  };
}
