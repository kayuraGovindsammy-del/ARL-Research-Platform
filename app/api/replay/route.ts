import { NextRequest, NextResponse } from "next/server";
import { getLatestSampleAt, getReplayContext, getSnapshot, getTelemetryBounds } from "@/lib/snapshot";
import { toService } from "@/lib/types";

/**
 * Historical snapshot API.
 *
 *   GET /api/replay?timestamp=2026-11-02T09:15:00Z&service=RTA
 *   GET /api/replay?timestamp=1762070400000        (epoch ms also accepted)
 *   GET /api/replay?bounds=1&service=RTA           (scrubber bounds)
 *
 * Returns the latest sample of every topic at or before `timestamp`, grouped
 * by topic so the dashboards can re-render a full instrument state — plus the
 * alerts that were live at that instant and the service events around it, so
 * replay is integrated with the alert system rather than chart-only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTimestamp(raw: string | null): Date | null {
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
  const service = toService(params.get("service") ?? "");

  try {
    if (params.get("bounds") === "1" || params.get("bounds") === "true") {
      const bounds = await getTelemetryBounds(service);
      return NextResponse.json({ service, ...bounds }, { headers: { "Cache-Control": "no-store" } });
    }

    const rawTimestamp = params.get("timestamp") ?? params.get("target");
    // Default to the platform clock: accelerated services publish on a
    // simulated timeline that runs ahead of wall clock.
    const latest = rawTimestamp ? null : await getLatestSampleAt(service);
    const fallback = latest && latest.getTime() > Date.now() ? latest : new Date();
    const target = parseTimestamp(rawTimestamp) ?? fallback;
    const [snapshot, context] = await Promise.all([
      getSnapshot(target, service),
      getReplayContext(target, service),
    ]);

    return NextResponse.json(
      { ...snapshot, context },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[replay] snapshot query failed:", error);
    return NextResponse.json(
      {
        error: "Failed to build replay snapshot.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
