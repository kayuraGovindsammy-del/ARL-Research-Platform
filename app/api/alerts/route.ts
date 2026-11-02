import { NextRequest, NextResponse } from "next/server";
import { listAlerts, normalizeStatus } from "@/lib/alerts";
import { prisma } from "@/lib/prisma";
import { ALERT_STATUSES, toService, type AlertStatus } from "@/lib/types";

/**
 * Alert collection.
 *
 *   GET /api/alerts?status=ACTIVE,ACKNOWLEDGED&service=MHE&limit=100
 *
 * The annunciator polls this endpoint for its initial state and then keeps it
 * current through the SSE `alert` events.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseStatuses(raw: string | null): AlertStatus[] | undefined {
  if (!raw) return undefined;
  const requested = raw
    .split(",")
    .map((value) => normalizeStatus(value.trim()))
    .filter((value): value is AlertStatus => (ALERT_STATUSES as readonly string[]).includes(value));
  return requested.length ? Array.from(new Set(requested)) : undefined;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const service = toService(params.get("service") ?? "");
  const statuses = parseStatuses(params.get("status"));
  const limit = Number(params.get("limit") ?? 200);

  try {
    const [alerts, grouped] = await Promise.all([
      listAlerts({ service, statuses, limit: Number.isFinite(limit) ? limit : 200 }),
      prisma.alert.groupBy({
        by: ["status"],
        where: service ? { service } : undefined,
        _count: { _all: true },
      }),
    ]);

    const counts: Record<AlertStatus, number> = { ACTIVE: 0, ACKNOWLEDGED: 0, RESOLVED: 0 };
    for (const row of grouped) {
      const status = normalizeStatus(row.status);
      counts[status] += row._count._all;
    }

    return NextResponse.json(
      { alerts, counts, service, statuses: statuses ?? ALERT_STATUSES },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[alerts] list failed:", error);
    return NextResponse.json(
      { error: "Failed to load alerts.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
