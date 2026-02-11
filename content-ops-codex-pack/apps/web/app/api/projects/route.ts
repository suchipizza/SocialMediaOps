import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase";

function parseSlotTimes(input: unknown) {
  if (!input) return ["09:00", "13:00", "18:00"];
  if (Array.isArray(input)) {
    return input.map(String).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
  return ["09:00", "13:00", "18:00"];
}

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ projects: data });
}

export async function POST(request: Request) {
  let payload: any = {};
  try {
    payload = await request.json();
  } catch (err) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = String(payload.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      description: payload.description || null,
      timezone: payload.timezone || "Europe/Zurich",
      platforms_enabled: payload.platforms_enabled || { instagram: true, tiktok: false },
      slot_times: parseSlotTimes(payload.slot_times)
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ project: data }, { status: 201 });
}
