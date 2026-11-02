import { NextRequest, NextResponse } from "next/server";
import { listAuditLogs } from "@/lib/alerts";

/** GET /api/audit?limit=50 — operator action trail. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  try {
    const entries = await listAuditLogs(Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[audit] list failed:", error);
    return NextResponse.json({ error: "Failed to load audit log." }, { status: 500 });
  }
}
