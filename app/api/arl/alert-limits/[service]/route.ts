import { NextResponse } from "next/server";
import { getAlertLimits } from "@/lib/arl-api";
import { arlApiDocsUrl } from "@/lib/env";
import { DEFAULT_ALERT_LIMITS, toService, type AlertLimits } from "@/lib/types";

/**
 * GET /api/arl/alert-limits/{rta|mhe|opg}
 *
 * The thresholds each service raises alerts on (`GET /v1/alert-limits/{svc}`).
 * The simulator's own defaults are merged underneath whatever the API returns
 * so the dashboards always have a complete table to render hints from, and the
 * response says which of the two sources produced each row.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { service: string } },
) {
  const service = toService(params.service);
  if (!service) {
    return NextResponse.json(
      { error: `Unknown service '${params.service}'. Expected rta, mhe or opg.` },
      { status: 404 },
    );
  }

  const defaults: AlertLimits = Object.fromEntries(
    Object.entries(DEFAULT_ALERT_LIMITS[service]).map(([key, value]) => [
      key,
      { key, value, unit: null },
    ]),
  );

  try {
    const live = await getAlertLimits(service);
    return NextResponse.json(
      {
        service,
        limits: { ...defaults, ...live },
        source: "arl",
        docsUrl: arlApiDocsUrl(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[arl] alert limits for ${service} unavailable:`, message);
    return NextResponse.json(
      { service, limits: defaults, source: "fallback", error: message, docsUrl: arlApiDocsUrl() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
