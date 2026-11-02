import { Prisma } from "@prisma/client";
import { toAlertRecord } from "./alerts";
import { prisma } from "./prisma";
import { parseTopic } from "./topics";
import type { AlertRecord, ReplayContext, ReplaySnapshot, Service, TopicState } from "./types";

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

/** Alerts raised inside this window of the cursor are shown as context. */
export const REPLAY_CONTEXT_WINDOW_MS = 30 * 60 * 1000;

/**
 * The alert's lifecycle state *as it was at the cursor*, not as it is now.
 * A row that has since been resolved was still ACTIVE at the time.
 */
export function alertStatusAt(alert: AlertRecord, targetTime: Date): AlertRecord["status"] {
  const at = targetTime.getTime();
  if (alert.resolvedAt && Date.parse(alert.resolvedAt) <= at) return "RESOLVED";
  if (alert.acknowledgedAt && Date.parse(alert.acknowledgedAt) <= at) return "ACKNOWLEDGED";
  return "ACTIVE";
}

/**
 * Everything replay needs beyond instrument values: which alerts were live at
 * the cursor, which were raised in the preceding window, and the service events
 * (scan lifecycle, surveys, refuels, …) that happened around it.
 */
export async function getReplayContext(
  targetTime: Date,
  service: Service | null,
  windowMs = REPLAY_CONTEXT_WINDOW_MS,
): Promise<ReplayContext> {
  const windowStart = new Date(targetTime.getTime() - windowMs);
  const scope = service ? { service } : {};

  const [live, recent, eventRows] = await Promise.all([
    prisma.alert.findMany({
      where: {
        ...scope,
        timestamp: { lte: targetTime },
        OR: [{ resolvedAt: null }, { resolvedAt: { gt: targetTime } }],
      },
      orderBy: { timestamp: "desc" },
      take: 100,
    }),
    prisma.alert.findMany({
      where: { ...scope, timestamp: { gte: windowStart, lte: targetTime } },
      orderBy: { timestamp: "desc" },
      take: 50,
    }),
    prisma.telemetry.findMany({
      where: {
        ...scope,
        topic: { contains: "/events/" },
        timestamp: { gte: windowStart, lte: targetTime },
      },
      orderBy: { timestamp: "asc" },
      take: 100,
      select: { service: true, topic: true, payload: true, timestamp: true },
    }),
  ]);

  const asAt = (rows: Array<Parameters<typeof toAlertRecord>[0]>): AlertRecord[] =>
    rows.map((row) => {
      const record = toAlertRecord(row);
      return { ...record, status: alertStatusAt(record, targetTime) };
    });

  const events = eventRows.map((row) => ({
    service: row.service,
    kind: parseTopic(row.topic).name ?? "event",
    payload: parsePayload(row.payload),
    timestamp: toIso(row.timestamp),
  }));

  return {
    activeAlerts: asAt(live),
    recentAlerts: asAt(recent),
    events,
    windowMs,
  };
}

/**
 * The newest sample time in the database, or null when nothing has arrived.
 *
 * Services run under `ARL_SPEEDUP`, so their simulated clock — and therefore
 * every `ts` they publish — can be hours ahead of wall clock. "Now" for the
 * platform is the later of the two, never the wall clock alone.
 */
export async function getLatestSampleAt(service: Service | null): Promise<Date | null> {
  const row = await prisma.telemetry.findFirst({
    where: service ? { service } : undefined,
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  return row?.timestamp ?? null;
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
 * Samples of a single topic between `since` and `until`, used to seed charts.
 *
 * `until` is what makes a chart follow the replay cursor: without it the window
 * would always end at the newest sample, so scrubbing back would change the
 * instrument panels but the trend would keep describing the present.
 */
export async function getTopicHistory(
  topic: string,
  since: Date,
  limit = 240,
  until?: Date | null,
): Promise<Array<{ payload: Record<string, unknown>; timestamp: string }>> {
  const rows = await prisma.telemetry.findMany({
    where: {
      topic,
      timestamp: until ? { gte: since, lte: until } : { gte: since },
    },
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

/**
 * Recording range of one topic.
 *
 * A chart that comes back empty inside a replay window is ambiguous: either the
 * topic is silent, or the window reaches back further than the recording does.
 * This says which, so the panel can point at the first sample instead of
 * leaving the researcher to guess.
 */
export async function getTopicBounds(
  topic: string,
): Promise<{ earliest: string | null; latest: string | null; samples: number }> {
  const [bounds, samples] = await Promise.all([
    prisma.telemetry.aggregate({
      where: { topic },
      _min: { timestamp: true },
      _max: { timestamp: true },
    }),
    prisma.telemetry.count({ where: { topic } }),
  ]);

  return {
    earliest: bounds._min.timestamp ? bounds._min.timestamp.toISOString() : null,
    latest: bounds._max.timestamp ? bounds._max.timestamp.toISOString() : null,
    samples,
  };
}

/**
 * Newest sample of one exact topic, optionally narrowed by a payload substring.
 *
 * Events are published once, so the in-memory map that the worker keeps for
 * live context is empty after a restart. Reading the row back lets a scan
 * started before the process booted still be reconstructed; the substring
 * filter is how a specific event kind (`started`, not `completed`) is picked
 * out of a topic that carries several.
 */
export async function getLatestTopicSample(
  topic: string,
  payloadContains?: string,
): Promise<{ payload: Record<string, unknown>; timestamp: string } | null> {
  const row = await prisma.telemetry.findFirst({
    where: payloadContains
      ? { topic, payload: { contains: payloadContains } }
      : { topic },
    orderBy: { timestamp: "desc" },
    select: { payload: true, timestamp: true },
  });
  if (!row) return null;
  return { payload: parsePayload(row.payload), timestamp: row.timestamp.toISOString() };
}

/**
 * Every sample of one scan stream (`arl/<svc>/<dish>/telemetry/scan`) recorded
 * since a timestamp, for rebuilding a scan image that started before the page
 * or the server process did.
 *
 * The scan id lives inside the JSON payload, which SQLite cannot index here, so
 * the query narrows by topic suffix and time and the caller filters by id.
 */
export async function getStreamSamplesSince(
  topicPrefix: string,
  stream: string,
  since: Date,
  limit = 200_000,
): Promise<Array<{ topic: string; payload: Record<string, unknown>; timestamp: string }>> {
  const rows = await prisma.telemetry.findMany({
    where: {
      topic: { startsWith: topicPrefix, endsWith: `/${stream}` },
      timestamp: { gte: since },
    },
    orderBy: { timestamp: "asc" },
    take: limit,
    select: { topic: true, payload: true, timestamp: true },
  });

  return rows.map((row) => ({
    topic: row.topic,
    payload: parsePayload(row.payload),
    timestamp: row.timestamp.toISOString(),
  }));
}
