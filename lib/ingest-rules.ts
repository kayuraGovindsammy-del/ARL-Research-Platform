import { scanTargetLabel } from "./rta-selectors";
import type { ServiceAlertEvent } from "./alerts";
import type { RtaScanContext } from "./types";

/**
 * Ingestion rules: how a raw broker payload becomes a domain record.
 *
 * These functions are deliberately pure and free of MQTT/Prisma types so the
 * rules that decide *what we keep and what we throw away* can be unit tested
 * against captured lab payloads (see `tests/ingest-rules.test.ts`). The worker
 * in `lib/mqtt-worker.ts` only wires them to the client and the database.
 */

/** Payloads above this size are dropped rather than persisted. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Samples whose `ts` is further than this from the receive time are re-stamped. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Parse a JSON payload.
 *
 * Returns `null` when the message is unusable (too large), `{}` for an empty
 * body, `{value}` for a bare JSON scalar, and `{raw}` for non-JSON text — a
 * plain-text sample is still worth keeping for replay.
 */
export function parsePayload(buffer: { length: number; toString(encoding: "utf8"): string }): Record<
  string,
  unknown
> | null {
  if (buffer.length > MAX_PAYLOAD_BYTES) return null;
  const text = buffer.toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: text };
  }
}

/**
 * The services stamp `ts` (ms since epoch). Keeping it makes replay reflect the
 * lab clock instead of our receive time, but bogus values are rejected.
 */
export function resolveTimestamp(payload: Record<string, unknown>, now: Date): Date {
  const candidate = payload.ts ?? payload.timestamp;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const value = candidate > 1e12 ? candidate : candidate * 1000;
    const date = new Date(value);
    if (Math.abs(date.getTime() - now.getTime()) < RETENTION_MS) return date;
  }
  if (typeof candidate === "string" && candidate.trim()) {
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime()) && Math.abs(date.getTime() - now.getTime()) < RETENTION_MS) {
      return date;
    }
  }
  return now;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `arl/<svc>/events/alert` → a service alert event, or null when the payload
 * is missing the three fields that make it actionable.
 */
export function toAlertEvent(payload: Record<string, unknown>): ServiceAlertEvent | null {
  const alertId = str(payload.alert_id);
  const type = str(payload.type);
  const state = str(payload.state);
  if (!alertId || !type || !state) return null;
  return {
    alertId,
    type,
    state,
    severity: str(payload.severity) ?? "warning",
    value: num(payload.value),
    limit: num(payload.limit),
    unit: str(payload.unit),
    message: str(payload.message),
    entity: str(payload.entity),
    metadata:
      payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  };
}

/**
 * `arl/rta/events/scan` carries `started`, `progress` and terminal events; only
 * `started` holds the grid geometry the scan canvas needs to decode samples.
 */
export function toScanContext(
  payload: Record<string, unknown>,
  at: Date,
): RtaScanContext | null {
  if (str(payload.event) !== "started") return null;
  const scanId = str(payload.scan_id);
  const ra = num(payload.ra_rad);
  const dec = num(payload.dec_rad);
  const fov = num(payload.fov_rad);
  if (!scanId || ra === null || dec === null || fov === null) return null;
  return {
    scanId,
    target: scanTargetLabel(payload),
    raRad: ra,
    decRad: dec,
    fovRad: fov,
    bandHz: num(payload.band_hz) ?? 0,
    gridSize: num(payload.grid_size) ?? 128,
    overlap: num(payload.overlap) ?? 3,
    dishes: Array.isArray(payload.dishes) ? payload.dishes.map((id) => String(id)) : [],
    expectedDurationS: num(payload.expected_duration_s) ?? 0,
    origin: str(payload.origin) ?? "command",
    startedAt: at.toISOString(),
  };
}
