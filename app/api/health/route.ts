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

  const database: DatabaseStatus = envStatus.ok
    ? await probeDatabase()
    : { ok: false, detail: "environment invalid" };

  const worker = getMqttWorker().getStatus();
  const healthy = envStatus.ok && database.ok;

  return NextResponse.json(
    {
      ok: healthy,
      time: new Date().toISOString(),
      env: envStatus,
      database,
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
