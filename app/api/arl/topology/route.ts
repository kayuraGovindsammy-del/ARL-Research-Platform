import { NextResponse } from "next/server";
import { ensureMqttWorker } from "@/lib/mqtt-worker";
import { INGEST_SERVICES, toIngestService } from "@/lib/types";

/**
 * GET /api/arl/topology              all retained `$topology` documents
 * GET /api/arl/topology?service=rta  one service's capability document
 *
 * This is the live contract the services advertise: entities, streams, state
 * items, events and the control catalogue with its accepted value ranges. The
 * console reads it to explain itself (which controls exist, which units a
 * stream reports) instead of hardcoding the simulator's shape.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const worker = ensureMqttWorker();
  const requested = new URL(request.url).searchParams.get("service");

  if (requested) {
    const service = toIngestService(requested);
    if (!service) {
      return NextResponse.json(
        { error: `Unknown service '${requested}'. Expected one of ${INGEST_SERVICES.join(", ")}.` },
        { status: 404 },
      );
    }
    const topology = worker.getTopology(service);
    if (!topology) {
      return NextResponse.json(
        { error: `No $topology received from ${service} yet.` },
        { status: 503 },
      );
    }
    return NextResponse.json({ service, topology }, { headers: { "Cache-Control": "no-store" } });
  }

  const topologies: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const service of INGEST_SERVICES) {
    const topology = worker.getTopology(service);
    if (topology) topologies[service] = topology;
    else missing.push(service);
  }

  return NextResponse.json(
    { topologies, missing },
    { headers: { "Cache-Control": "no-store" } },
  );
}
