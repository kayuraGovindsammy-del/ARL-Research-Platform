import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ensureMqttWorker } from "@/lib/mqtt-worker";
import { getLatestScanContext } from "@/lib/rta-selectors";
import { addScanPayload, createScanImage, serializeImage } from "@/lib/scan-image";
import { getLatestTopicSample, getStreamSamplesSince } from "@/lib/snapshot";
import type { RtaScanContext } from "@/lib/types";

/**
 * GET /api/rta/scan              the latest scan the platform knows about
 * GET /api/rta/scan?scanId=…     one specific scan
 *
 * The scan image is built from two inputs that only exist together in memory
 * today: the `started` event (grid size, field of view, overlap) and the 1 Hz
 * per-dish `telemetry/scan` samples. Rebuilding it from the database lets the
 * operator open the dashboard mid-scan and still see the whole image instead of
 * the pixels that happened to arrive after the page loaded.
 *
 * The `started` event is published once, so the worker's in-memory context is
 * empty after a restart; the newest event row is read back as a fallback.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function recoverContext(scanId: string | null): Promise<RtaScanContext | null> {
  // `events/scan` carries `started`, `progress` and terminal events; only the
  // started event holds the grid geometry the canvas needs.
  const event = await getLatestTopicSample(
    `${env().MQTT_TOPIC_PREFIX}/rta/events/scan`,
    '"event":"started"',
  );
  if (!event) return null;

  const context = getLatestScanContext([
    { kind: "scan", payload: event.payload, timestamp: event.timestamp },
  ]);
  if (!context) return null;
  return scanId && context.scanId !== scanId ? null : context;
}

export async function GET(request: NextRequest) {
  const worker = ensureMqttWorker();
  const scanId = new URL(request.url).searchParams.get("scanId");

  let context: RtaScanContext | null = worker.getScanContext(scanId);
  if (!context) {
    try {
      context = await recoverContext(scanId);
    } catch (error) {
      console.error("[rta] scan context recovery failed:", error);
    }
  }

  if (!context) {
    return NextResponse.json(
      {
        context: null,
        image: null,
        reason: "No scan has been recorded yet.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const image = createScanImage({
    scanId: context.scanId,
    size: context.gridSize,
    overlap: context.overlap,
    fovRad: context.fovRad,
  });

  try {
    const samples = await getStreamSamplesSince(
      `${env().MQTT_TOPIC_PREFIX}/rta`,
      "telemetry/scan",
      new Date(context.startedAt),
    );
    for (const sample of samples) addScanPayload(image, sample.payload);

    return NextResponse.json(
      {
        context,
        image: serializeImage(image),
        storedSamples: samples.length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[rta] scan image rebuild failed:", error);
    // The live stream can still fill the canvas; report the context alone.
    return NextResponse.json(
      { context, image: serializeImage(image), storedSamples: 0, error: "History unavailable." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
