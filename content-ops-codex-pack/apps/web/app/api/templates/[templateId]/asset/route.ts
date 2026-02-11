import { NextResponse } from "next/server";
import { loadTemplateAsset } from "../../../../../lib/template-pack";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const { templateId } = await params;
  const url = new URL(_request.url);
  const assetPath = url.searchParams.get("path");
  if (!assetPath) {
    return NextResponse.json({ error: "path_required" }, { status: 400 });
  }

  if (assetPath.includes("..") || assetPath.startsWith("/") || assetPath.includes("\\") || assetPath.includes("\0")) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  try {
    const { bytes, contentType } = await loadTemplateAsset({ templateId, assetPath });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=3600"
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "asset_failed" }, { status: 404 });
  }
}
