import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createSupabaseServerClient } from "../../../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isMediaContentType(contentType: string | null | undefined) {
  if (!contentType) return false;
  const normalized = String(contentType).split(";")[0]?.trim().toLowerCase();
  return normalized.startsWith("image/") || normalized.startsWith("video/");
}

function parseAssetIdFromPath(requestUrl: string) {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const raw = parts[parts.length - 1] || "";
  return decodeURIComponent(raw);
}

function signToken({ assetId, exp, secret }: { assetId: string; exp: number; secret: string }) {
  return createHmac("sha256", secret).update(`${assetId}:${exp}`).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (!left.length || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const assetId = parseAssetIdFromPath(request.url);
  const expRaw = url.searchParams.get("exp") || "";
  const sig = String(url.searchParams.get("sig") || "").trim();
  const secret = String(process.env.PUBLISH_MEDIA_PROXY_SECRET || "").trim();

  if (!secret) {
    return NextResponse.json({ error: "proxy_secret_missing" }, { status: 503 });
  }
  if (!assetId) {
    return NextResponse.json({ error: "asset_id_required" }, { status: 400 });
  }

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) {
    return NextResponse.json({ error: "invalid_exp" }, { status: 400 });
  }
  if (Math.floor(Date.now() / 1000) > exp) {
    return NextResponse.json({ error: "url_expired" }, { status: 403 });
  }

  const expectedSig = signToken({ assetId, exp, secret });
  if (!safeEqualHex(sig, expectedSig)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  const supabase = createSupabaseServerClient();
  const { data: asset, error } = await supabase
    .from("assets")
    .select("id,image_url,mime")
    .eq("id", assetId)
    .single();

  if (error || !asset?.image_url) {
    return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }

  const upstream = await fetch(String(asset.image_url), { method: "GET" });
  if (!upstream.ok) {
    return NextResponse.json({ error: `asset_fetch_failed:${upstream.status}` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || String(asset.mime || "application/octet-stream");
  if (!isMediaContentType(contentType)) {
    return NextResponse.json(
      {
        error: "asset_invalid_media_type",
        content_type: contentType || null
      },
      { status: 502 }
    );
  }
  const body = Buffer.from(await upstream.arrayBuffer());

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300, stale-while-revalidate=120"
    }
  });
}
