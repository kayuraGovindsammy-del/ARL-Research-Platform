import { prisma, withDbRetry } from "./prisma";
import { guidanceFor } from "./alert-guidance";
import { platformNow } from "./clock";
import { publishAlert } from "./events";
import { ALERT_STATUSES, type AlertRecord, type AlertStatus } from "./types";

/**
 * Alert lifecycle + operator audit trail.
 *
 * Deduplication contract: at most one ACTIVE alert exists per
 * (service, alertType). Entity-scoped conditions (a single dish overheating)
 * therefore encode the entity into `alertType`, e.g.
 * `RTA_DISH_OVERHEAT:D-042`, while array-wide conditions stay generic
 * (`RTA_DISH_CAPACITY_LOW`).
 *
 * Persistence contract (the annunciator's evidence trail): every row records
 * the raised timestamp, the acknowledgement timestamp + user, the resolution
 * timestamp + user, and the cause — the rule, the entity and the value that
 * breached its limit. Acknowledging and resolving also write an AuditLog row.
 */

export class AlertOperationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AlertOperationError";
    this.status = status;
  }
}

type RawAlert = {
  id: string;
  service: string;
  alertType: string;
  message: string;
  status: string;
  timestamp: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  cause: string | null;
  severity: string | null;
  entity: string | null;
  value: number | null;
  limitValue: number | null;
  unit: string | null;
  context: string | null;
};

export function toAlertRecord(alert: RawAlert): AlertRecord {
  return {
    id: alert.id,
    service: alert.service,
    alertType: alert.alertType,
    message: alert.message,
    status: normalizeStatus(alert.status),
    timestamp: alert.timestamp.toISOString(),
    acknowledgedBy: alert.acknowledgedBy,
    acknowledgedAt: alert.acknowledgedAt ? alert.acknowledgedAt.toISOString() : null,
    resolvedBy: alert.resolvedBy,
    resolvedAt: alert.resolvedAt ? alert.resolvedAt.toISOString() : null,
    resolutionNote: alert.resolutionNote,
    cause: alert.cause,
    severity: alert.severity,
    entity: alert.entity,
    value: alert.value,
    limitValue: alert.limitValue,
    unit: alert.unit,
    context: alert.context,
  };
}

export function normalizeStatus(value: string): AlertStatus {
  const upper = value?.toUpperCase();
  return (ALERT_STATUSES as readonly string[]).includes(upper)
    ? (upper as AlertStatus)
    : "ACTIVE";
}

// ---------------------------------------------------------------------------
// Service-originated alerts (`arl/<svc>/events/alert`)
// ---------------------------------------------------------------------------

export interface ServiceAlertEvent {
  alertId: string;
  type: string;
  severity: string;
  state: "raised" | "cleared" | string;
  value?: number | null;
  limit?: number | null;
  unit?: string | null;
  message?: string | null;
  entity?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Dedupe key for a service alert. The service reports escalations under the
 * same `alert_id`, and entity-scoped alerts (one dish overheating) reuse the
 * same `type`, so the id is what keeps them distinct.
 */
export function serviceAlertType(event: ServiceAlertEvent): string {
  return `${event.type}:${event.alertId}`;
}

export function formatAlertMessage(event: ServiceAlertEvent): string {
  const parts: string[] = [];
  if (event.message) parts.push(event.message);
  if (event.entity && event.entity !== "global") parts.push(event.entity);
  if (typeof event.value === "number") {
    const unit = event.unit ? ` ${event.unit}` : "";
    const limit = typeof event.limit === "number" ? ` (limit ${event.limit}${unit})` : "";
    parts.push(`${event.value}${unit}${limit}`);
  }
  if (event.severity) parts.push(`[${event.severity}]`);
  return parts.join(" · ") || `${event.type} alert`;
}

/**
 * The cause answers "why did this fire?", independently of the prose in
 * `message`: the rule, the entity it applies to, and the measured value
 * against the limit that defined it.
 */
export function formatAlertCause(event: ServiceAlertEvent): string {
  const rule = event.type;
  const target = event.entity && event.entity !== "global" ? event.entity : "the service";
  if (typeof event.value === "number" && typeof event.limit === "number") {
    const unit = event.unit ? ` ${event.unit}` : "";
    const direction = event.value > event.limit ? "above" : "below";
    return `${rule} on ${target}: ${event.value}${unit} is ${direction} the ${event.limit}${unit} limit`;
  }
  if (typeof event.value === "number") {
    const unit = event.unit ? ` ${event.unit}` : "";
    return `${rule} on ${target}: reported ${event.value}${unit}`;
  }
  return `${rule} on ${target}`;
}

/**
 * Persist a raised service alert. Escalations reuse the same `alert_id`, so an
 * ACTIVE row has its context refreshed instead of being duplicated.
 */
export async function raiseServiceAlert(
  service: string,
  event: ServiceAlertEvent,
  timestamp?: Date,
): Promise<AlertRecord | null> {
  const alertType = serviceAlertType(event);
  const message = formatAlertMessage(event);
  const cause = formatAlertCause(event);
  const guidance = guidanceFor(alertType, service);
  const context = JSON.stringify({
    rule: event.type,
    alertId: event.alertId,
    state: event.state,
    guidance: guidance.headline,
    suggestedAction: guidance.action,
    metadata: event.metadata ?? null,
  });

  try {
    const existing = await prisma.alert.findFirst({
      where: { service, alertType, status: "ACTIVE" },
      select: { id: true, message: true, severity: true },
    });
    if (existing) {
      // Only touch the row when the escalation actually changed something.
      if (existing.message === message && existing.severity === event.severity) return null;
      const refreshed = await withDbRetry(
        (): Promise<RawAlert> =>
          prisma.alert.update({
            where: { id: existing.id },
            data: {
              message,
              cause,
              severity: event.severity,
              value: event.value ?? null,
              limitValue: event.limit ?? null,
              unit: event.unit ?? null,
              context,
            },
          }),
        "alert escalate",
      );
      const record = toAlertRecord(refreshed);
      publishAlert(record);
      return record;
    }

    const raisedAt = timestamp ?? new Date();

    // Alert events are retained, so a resubscribe (or a platform restart)
    // redelivers the same lab event. Identity is (service, alertType, raised
    // timestamp): a condition that genuinely recurs carries a new `ts`, so an
    // identical timestamp is a redelivery and must not become a second row.
    const alreadyRecorded = await prisma.alert.findFirst({
      where: { service, alertType, timestamp: raisedAt },
      select: { id: true },
    });
    if (alreadyRecorded) return null;

    const created = await withDbRetry(
      (): Promise<RawAlert> =>
        prisma.alert.create({
          data: {
            service,
            alertType,
            message,
            status: "ACTIVE",
            timestamp: raisedAt,
            cause,
            severity: event.severity,
            entity: event.entity ?? null,
            value: event.value ?? null,
            limitValue: event.limit ?? null,
            unit: event.unit ?? null,
            context,
          },
        }),
      "alert create",
    );
    const record = toAlertRecord(created);
    publishAlert(record);
    return record;
  } catch (error) {
    console.error("[alert] failed to record service alert:", error);
    return null;
  }
}

/** Resolve the ACTIVE row for a cleared service alert. */
export async function clearServiceAlert(
  service: string,
  event: ServiceAlertEvent,
  at?: Date,
): Promise<AlertRecord | null> {
  const alertType = serviceAlertType(event);
  try {
    const existing = await prisma.alert.findFirst({
      where: { service, alertType, status: "ACTIVE" },
      select: { id: true },
    });
    if (!existing) return null;

    const resolvedAt = at ?? (await platformNow());
    const updated = await withDbRetry(
      (): Promise<RawAlert> =>
        prisma.alert.update({
          where: { id: existing.id },
          data: {
            status: "RESOLVED",
            resolvedBy: `${service} service`,
            resolvedAt,
            resolutionNote: `Cleared automatically: ${event.message ?? event.type} is no longer active.`,
          },
        }),
      "alert auto-resolve",
    );
    const record = toAlertRecord(updated);
    publishAlert(record);
    return record;
  } catch (error) {
    console.error("[alert] failed to clear service alert:", error);
    return null;
  }
}

export interface ListAlertsOptions {
  service?: string | null;
  statuses?: AlertStatus[];
  limit?: number;
}

export async function listAlerts({
  service,
  statuses,
  limit = 200,
}: ListAlertsOptions = {}): Promise<AlertRecord[]> {
  const alerts = await prisma.alert.findMany({
    where: {
      ...(service ? { service } : {}),
      ...(statuses && statuses.length ? { status: { in: statuses } } : {}),
    },
    orderBy: [{ timestamp: "desc" }],
    take: Math.min(Math.max(limit, 1), 1000),
  });
  return alerts.map(toAlertRecord);
}

function requireActor(actor: string, field: string): string {
  const trimmed = (actor ?? "").trim();
  if (trimmed.length < 2) {
    throw new AlertOperationError(`${field} is required (minimum 2 characters).`, 422);
  }
  if (trimmed.length > 120) {
    throw new AlertOperationError(`${field} must be 120 characters or fewer.`, 422);
  }
  return trimmed;
}

export async function acknowledgeAlert(
  id: string,
  actor: string,
  note?: string,
): Promise<AlertRecord> {
  const performedBy = requireActor(actor, "Researcher name/ID");
  const alert = await prisma.alert.findUnique({ where: { id } });
  if (!alert) throw new AlertOperationError("Alert not found.", 404);
  if (alert.status === "RESOLVED") {
    throw new AlertOperationError("Resolved alerts cannot be acknowledged.", 409);
  }
  if (alert.status === "ACKNOWLEDGED") {
    throw new AlertOperationError("Alert is already acknowledged.", 409);
  }

  const now = await platformNow();
  const updated = await withDbRetry(
    (): Promise<RawAlert> =>
      prisma.alert.update({
        where: { id },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedBy: performedBy,
          acknowledgedAt: now,
          // `resolutionNote` is reserved for the resolution narrative; the optional
          // acknowledgement note only travels in the audit trail below.
        },
      }),
    "alert acknowledge",
  );

  await writeAuditLog(
    "ALERT_ACKNOWLEDGED",
    performedBy,
    `Alert ${alert.id} (${alert.service}/${alert.alertType}) acknowledged${
      note?.trim() ? ` — ${note.trim()}` : ""
    }`,
    now,
  );

  const record = toAlertRecord(updated);
  publishAlert(record);
  return record;
}

export async function resolveAlert(
  id: string,
  actor: string,
  resolutionNote: string,
): Promise<AlertRecord> {
  const performedBy = requireActor(actor, "Researcher name/ID");
  const note = (resolutionNote ?? "").trim();
  if (note.length < 3) {
    throw new AlertOperationError("Resolution text is required (minimum 3 characters).", 422);
  }

  const alert = await prisma.alert.findUnique({ where: { id } });
  if (!alert) throw new AlertOperationError("Alert not found.", 404);
  if (alert.status === "RESOLVED") {
    throw new AlertOperationError("Alert is already resolved.", 409);
  }

  const now = await platformNow();
  const updated = await withDbRetry(
    (): Promise<RawAlert> =>
      prisma.alert.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedBy: performedBy,
          resolvedAt: now,
          resolutionNote: note,
          // Keep the acknowledgement trail intact; backfill it when the operator
          // resolves without acknowledging first.
          acknowledgedBy: alert.acknowledgedBy ?? performedBy,
          acknowledgedAt: alert.acknowledgedAt ?? now,
        },
      }),
    "alert resolve",
  );

  await writeAuditLog(
    "ALERT_RESOLVED",
    performedBy,
    `Alert ${alert.id} (${alert.service}/${alert.alertType}) resolved — ${note}`,
    now,
  );

  const record = toAlertRecord(updated);
  publishAlert(record);
  return record;
}

export async function writeAuditLog(
  action: string,
  performedBy: string,
  details: string,
  at?: Date,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      // Stamped on the platform clock so an audit entry sorts against the alert
      // it describes, which is what a replay of that moment has to show.
      data: { action, performedBy, details, ...(at ? { timestamp: at } : {}) },
    });
  } catch (error) {
    console.error("[audit] failed to persist audit log entry", error);
  }
}

export async function listAuditLogs(limit = 100) {
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    performedBy: log.performedBy,
    details: log.details,
    timestamp: log.timestamp.toISOString(),
  }));
}
