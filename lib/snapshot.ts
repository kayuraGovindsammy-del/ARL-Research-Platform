import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import type { ReplaySnapshot, Service, TopicState } from "./types";

/**
 * Snapshot read model shared by the replay API and the live hydration API.
 *
 * The "latest sample per topic at or before T" query uses a SQLite window
 * function, which keeps a single round trip even with hundreds of dish/room
 * topics. Prisma stores DateTime as an integer (ms since epoch) in SQLite, so
 * the bound Date parameter compares correctly.
 */

interface RawSnapshotRow {
  id: string;
  service: string;
  topic: string;
  payload: string;
  timestamp: Date | string | number;
}

function toIso(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

export async function getSnapshot(
  targetTime: Date,
  service: Service | null,
): Promise<ReplaySnapshot> {
  const rows = await prisma.$queryRaw<RawSnapshotRow[]>(Prisma.sql`
    SELECT id, service, topic, payload, timestamp
    FROM (
      SELECT id, service, topic, payload, timestamp,
             ROW_NUMBER() OVER (PARTITION BY topic ORDER BY timestamp DESC) AS rn
      FROM "Telemetry"
      WHERE timestamp <= ${targetTime}
      ${service ? Prisma.sql`AND service = ${service}` : Prisma.empty}
    )
    WHERE rn = 1
    ORDER BY topic ASC
  `);

  const topics: Record<string, TopicState> = {};
  for (const row of rows) {
    topics[row.topic] = {
      topic: row.topic,
      payload: parsePayload(row.payload),
      timestamp: toIso(row.timestamp),
    };
  }

  return {
    targetTime: targetTime.toISOString(),
    service,
    topics,
    count: rows.length,
  };
}

/** Earliest / latest timestamps available, used to bound the replay scrubber. */
export async function getTelemetryBounds(
  service: Service | null,
): Promise<{ earliest: string | null; latest: string | null; samples: number }> {
  const [bounds, samples] = await Promise.all([
    prisma.telemetry.aggregate({
      where: service ? { service } : undefined,
      _min: { timestamp: true },
      _max: { timestamp: true },
    }),
    prisma.telemetry.count({ where: service ? { service } : undefined }),
  ]);

  return {
    earliest: bounds._min.timestamp ? bounds._min.timestamp.toISOString() : null,
    latest: bounds._max.timestamp ? bounds._max.timestamp.toISOString() : null,
    samples,
  };
}

/**
 * Latest state of a single topic, used for chart seeding without waiting for a
 * live sample to arrive.
 */
export async function getTopicHistory(
  topic: string,
  since: Date,
  limit = 240,
): Promise<Array<{ payload: Record<string, unknown>; timestamp: string }>> {
  const rows = await prisma.telemetry.findMany({
    where: { topic, timestamp: { gte: since } },
    orderBy: { timestamp: "desc" },
    take: Math.min(Math.max(limit, 1), 2000),
    select: { payload: true, timestamp: true },
  });

  return rows
    .map((row) => ({
      payload: parsePayload(row.payload),
      timestamp: row.timestamp.toISOString(),
    }))
    .reverse();
}
