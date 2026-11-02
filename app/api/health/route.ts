import { NextResponse } from "next/server";
import { arlApiDocsUrl, env, inspectEnv } from "@/lib/env";
import { getMqttWorker } from "@/lib/mqtt-worker";
import { dbReady, isDatabaseBusy, prisma } from "@/lib/prisma";

/**
 * GET /api/health
 *
 * Platform readiness probe: environment contract, SQLite reachability and the
 * MQTT worker/broker state. Deliberately never includes broker credentials.
 *
 * The database check is a single indexed "newest sample" lookup rather than a
 * `count(*)`: this endpoint is polled by every dashboard, and a full table scan
 * here would compete with the ingestion writer for the SQLite lock.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DatabaseStatus {
  ok: boolean;
  detail: string;
  latestSampleAt?: string | null;
  busy?: boolean;
}

/**
 * Alert summary for the always-visible header strip.
 *
 * Only unresolved alerts are grouped (by status and severity), which keeps this
 * on the `status` index instead of scanning the alert log, and the newest
 * unresolved alert is one indexed row — the header needs the single most urgent
 * message, not the whole history.
 */
interface AlertSummary {
  ok: boolean;
  active: number;
  acknowledged: number;
  critical: number;
  warning: number;
  info: number;
  newest: {
    id: string;
    service: string;
    alertType: string;
    message: string;
    severity: string | null;
    status: string;
    timestamp: string;
  } | null;
}

async function probeAlerts(): Promise<AlertSummary> {
  const empty: AlertSummary = {
    ok: true,
    active: 0,
    acknowledged: 0,
    critical: 0,
    warning: 0,
    info: 0,
    newest: null,
  };
  try {
    const unresolved = { status: { in: ["ACTIVE", "ACKNOWLEDGED"] } };
    const [grouped, newest] = await Promise.all([
      prisma.alert.groupBy({
        by: ["status", "severity"],
        where: unresolved,
        _count: { _all: true },
      }),
      prisma.alert.findFirst({
        where: unresolved,
        orderBy: { timestamp: "desc" },
        select: {
          id: true,
          service: true,
          alertType: true,
          message: true,
          severity: true,
          status: true,
          timestamp: true,
        },
      }),
    ]);

    const summary = { ...empty };
    for (const row of grouped) {
      const count = row._count._all;
      if (row.status === "ACKNOWLEDGED") summary.acknowledged += count;
      else summary.active += count;
      if (row.severity === "critical") summary.critical += count;
      else if (row.severity === "info") summary.info += count;
      else summary.warning += count;
    }
    summary.newest = newest
      ? { ...newest, timestamp: newest.timestamp.toISOString() }
      : null;
    return summary;
  } catch (error) {
    console.error("[health] alert summary failed:", error);
    return { ...empty, ok: false };
  }
}

async function probeDatabase(): Promise<DatabaseStatus> {
  try {
    await dbReady;
    const latest = await prisma.telemetry.findFirst({
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    return {
      ok: true,
      detail: "reachable",
      latestSampleAt: latest ? latest.timestamp.toISOString() : null,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      busy: isDatabaseBusy(error),
    };
  }
}

export async function GET() {
  const envStatus = inspectEnv();

  const [database, alertSummary] = await Promise.all([
    envStatus.ok ? probeDatabase() : Promise.resolve<DatabaseStatus>({ ok: false, detail: "environment invalid" }),
    envStatus.ok ? probeAlerts() : Promise.resolve<AlertSummary | null>(null),
  ]);

  const worker = getMqttWorker().getStatus();
  const healthy = envStatus.ok && database.ok;

  return NextResponse.json(
    {
      ok: healthy,
      time: new Date().toISOString(),
      env: envStatus,
      database,
      alerts: alertSummary,
      mqtt: worker,
      arlApi: {
        docsUrl: envStatus.ok ? arlApiDocsUrl() : null,
      },
      researcher: envStatus.ok
        ? { code: env().ARL_RESEARCHER_CODE, name: env().ARL_RESEARCHER_NAME }
        : null,
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
