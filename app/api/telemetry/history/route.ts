import { NextRequest, NextResponse } from "next/server";
import { getTopicHistory } from "@/lib/snapshot";

/**
 * GET /api/telemetry/history?topic=arl/opg/power&minutes=30&limit=240
 *
 * Chronological samples for a single topic, used to seed the OPG trend chart.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const topic = params.get("topic");
  if (!topic) {
    return NextResponse.json({ error: "Query parameter 'topic' is required." }, { status: 422 });
  }

  const minutes = Math.min(Math.max(Number(params.get("minutes") ?? 30), 1), 24 * 60);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 240), 1), 2000);
  const since = new Date(Date.now() - minutes * 60 * 1000);

  try {
    const samples = await getTopicHistory(topic, since, limit);
    return NextResponse.json(
      { topic, since: since.toISOString(), samples },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[telemetry] history query failed:", error);
    return NextResponse.json({ error: "Failed to load topic history." }, { status: 500 });
  }
}
