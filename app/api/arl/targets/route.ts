import { NextRequest, NextResponse } from "next/server";
import { ArlApiError, getTargets, invalidateArlCache } from "@/lib/arl-api";
import { arlApiDocsUrl } from "@/lib/env";

/**
 * GET /api/arl/targets           cached pre-programmed target catalogue
 * GET /api/arl/targets?refresh=1 bypass the in-memory cache
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const refresh = request.nextUrl.searchParams.get("refresh");
  if (refresh === "1" || refresh === "true") invalidateArlCache();

  try {
    const targets = await getTargets();
    return NextResponse.json(
      { targets, source: "arl", docsUrl: arlApiDocsUrl() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[arl] target catalogue unavailable:", message);
    return NextResponse.json(
      {
        targets: [],
        source: "unavailable",
        error: message,
        docsUrl: arlApiDocsUrl(),
        status: error instanceof ArlApiError ? error.status : null,
      },
      { status: 502 },
    );
  }
}
