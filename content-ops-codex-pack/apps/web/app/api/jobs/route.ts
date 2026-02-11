import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id");

  const supabase = createSupabaseServerClient();
  let query = supabase.from("jobs").select("*").order("created_at", { ascending: false });
  if (projectId) {
    query = query.eq("project_id", projectId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ jobs: data });
}

export async function POST(request: Request) {
  let payload: any = {};
  try {
    payload = await request.json();
  } catch (err) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = String(payload.project_id || "").trim();
  const startDate = String(payload.start_date || "").trim();

  if (!projectId) {
    return NextResponse.json({ error: "project_id_required" }, { status: 400 });
  }
  if (!startDate) {
    return NextResponse.json({ error: "start_date_required" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      project_id: projectId,
      start_date: startDate,
      target_post_count: payload.target_post_count || 21,
      ingest_source: payload.ingest_source || "csv",
      status: payload.status || "RUNNING"
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ job: data }, { status: 201 });
}
