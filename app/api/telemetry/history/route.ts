import { NextRequest, NextResponse } from "next/server";
import { getLatestSampleAt, getTopicBounds, getTopicHistory } from "@/lib/snapshot";

/**
 * GET /api/telemetry/history?topic=arl/opg/global/telemetry/power&minutes=180
 * GET /api/telemetry/history?topic=…&minutes=180&until=2026-11-02T09:40:00Z
 *
 * Chronological samples for a single topic, used to seed the trend charts.
 *
 * The window ends at `until` (a replay cursor, ISO or epoch) when given, and at
 * the platform clock otherwise — accelerated services publish on a simulated
 * timeline ahead of real time, so "now" is the later of the two. Passing the
 * cursor is how a chart describes the moment being replayed rather than the
 * present.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseAnchor(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    // Accept either seconds or milliseconds since epoch.
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const topic = params.get("topic");
  if (!topic) {
    return NextResponse.json({ error: "Query parameter 'topic' is required." }, { status: 422 });
  }

  const minutes = Math.min(Math.max(Number(params.get("minutes") ?? 30), 1), 24 * 60);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 240), 1), 2000);
  const until = parseAnchor(params.get("until"));

  try {
    let anchor = until;
    if (!anchor) {
      // The window is measured back from the platform clock, not the wall clock:
      // accelerated services publish on a simulated timeline ahead of real time.
      const latest = await getLatestSampleAt(null);
      anchor = latest && latest.getTime() > Date.now() ? latest : new Date();
    }
    const since = new Date(anchor.getTime() - minutes * 60 * 1000);
    const samples = await getTopicHistory(topic, since, limit, until);
    // The extra aggregate only runs when the window came back empty, so the
    // normal chart request stays a single query. With it, an empty chart can
    // say "recorded from 11:20" instead of "no samples".
    const available = samples.length === 0 ? await getTopicBounds(topic) : null;
    return NextResponse.json(
      { topic, since: since.toISOString(), until: anchor.toISOString(), samples, available },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[telemetry] history query failed:", error);
    return NextResponse.json({ error: "Failed to load topic history." }, { status: 500 });
  }
}
