import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase";
import { createTemplateFromZip } from "../../../lib/templates";

export const runtime = "nodejs";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("templates")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: data });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  const name = String(formData.get("name") || "").trim();
  const platformScope = String(formData.get("platform_scope") || "both").trim();

  if (!file || typeof (file as File).arrayBuffer !== "function") {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }

  try {
    const template = await createTemplateFromZip({
      name,
      platformScope,
      file: file as File
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "upload_failed" }, { status: 400 });
  }
}
