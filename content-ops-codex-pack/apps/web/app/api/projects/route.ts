import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase";
import {
  buildUtcSchedulePreview,
  isValidTimezone,
  parseSlotTimesWithValidation
} from "../../../lib/schedule-validation";

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
  const timezone = String(payload.timezone || "Europe/Zurich").trim() || "Europe/Zurich";
  if (!isValidTimezone(timezone)) {
    return NextResponse.json({ error: `invalid_timezone:${timezone}` }, { status: 400 });
  }
  const { slotTimes, invalid } = parseSlotTimesWithValidation(payload.slot_times);
  if (invalid.length) {
    return NextResponse.json({ error: `invalid_slot_times:${invalid.join(",")}` }, { status: 400 });
  }
  try {
    buildUtcSchedulePreview({
      startDate: new Date().toISOString().slice(0, 10),
      timezone,
      slotTimes,
      previewCount: 3
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "project_schedule_preview_invalid" },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      description: payload.description || null,
      timezone,
      platforms_enabled: payload.platforms_enabled || { instagram: true, tiktok: false },
      slot_times: slotTimes
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ project: data }, { status: 201 });
}
