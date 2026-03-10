import { NextResponse } from "next/server";
import { validateGoogleSheetFormat } from "../../../../lib/sheet-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request_body"
      },
      { status: 400 }
    );
  }

  const sheetUrl = String(body?.sheet_url || "").trim();
  if (!sheetUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: "sheet_url_required"
      },
      { status: 400 }
    );
  }

  try {
    const result = await validateGoogleSheetFormat(sheetUrl);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(err?.message || err || "sheet_validation_failed")
      },
      { status: 500 }
    );
  }
}

