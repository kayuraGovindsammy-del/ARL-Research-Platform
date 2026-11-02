import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/snapshot";
import { ensureMqttWorker } from "@/lib/mqtt-worker";
import { toService } from "@/lib/types";

/**
 * GET /api/telemetry?service=OPG
 *
 * Latest value of every topic for the requested instrument. Used to hydrate a
 * dashboard immediately on mount; subsequent updates arrive over SSE.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const service = toService(request.nextUrl.searchParams.get("service") ?? "");

  try {
    ensureMqttWorker();
    const snapshot = await getSnapshot(new Date(), service);
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[telemetry] latest snapshot failed:", error);
    return NextResponse.json(
      { error: "Failed to load telemetry.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
