import { prisma, withDbRetry } from "./prisma";
import { publishAlert } from "./events";
import {
  ALERT_STATUSES,
  type AlertRecord,
  type AlertStatus,
  type AlertFlag,
  type Service,
} from "./types";

/**
 * Alert lifecycle + operator audit trail.
 *
 * Deduplication contract: at most one ACTIVE alert exists per
 * (service, alertType). Entity-scoped conditions (a single dish overheating)
 * therefore encode the entity into `alertType`, e.g.
 * `RTA_DISH_OVERHEAT:D-042`, while array-wide conditions stay generic
 * (`RTA_DISH_CAPACITY_LOW`).
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
  };
}

export function normalizeStatus(value: string): AlertStatus {
  const upper = value?.toUpperCase();
  return (ALERT_STATUSES as readonly string[]).includes(upper)
    ? (upper as AlertStatus)
    : "ACTIVE";
}

/** In-flight guard so concurrent samples cannot create duplicate rows. */
const inFlight = new Set<string>();

export interface RaiseAlertInput {
  service: Service | string;
  flag: AlertFlag;
  timestamp?: Date;
}

/**
 * Create an alert unless an ACTIVE alert with the same (service, alertType)
 * already exists. Returns the created record, or null when suppressed.
 */
export async function raiseAlert({
  service,
  flag,
  timestamp,
}: RaiseAlertInput): Promise<AlertRecord | null> {
  const alertType = flag.type.trim();
  const message = flag.message.trim();
  if (!alertType || !message) return null;

  const dedupeKey = `${service}|${alertType}`;
  if (inFlight.has(dedupeKey)) return null;
  inFlight.add(dedupeKey);

  try {
    const existing = await prisma.alert.findFirst({
      where: { service, alertType, status: "ACTIVE" },
      select: { id: true },
    });
    if (existing) return null;

    const created = await withDbRetry(
      (): Promise<RawAlert> =>
        prisma.alert.create({
          data: {
            service,
            alertType,
            message,
            status: "ACTIVE",
            timestamp: timestamp ?? new Date(),
          },
        }),
      "alert create",
    );

    const record = toAlertRecord(created);
    publishAlert(record);
    return record;
  } finally {
    inFlight.delete(dedupeKey);
  }
}

export async function raiseAlerts(
  service: Service | string,
  flags: AlertFlag[],
  timestamp?: Date,
): Promise<AlertRecord[]> {
  const created: AlertRecord[] = [];
  for (const flag of flags) {
    const record = await raiseAlert({ service, flag, timestamp });
    if (record) created.push(record);
  }
  return created;
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

  const now = new Date();
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

  const now = new Date();
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
  );

  const record = toAlertRecord(updated);
  publishAlert(record);
  return record;
}

export async function writeAuditLog(
  action: string,
  performedBy: string,
  details: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { action, performedBy, details } });
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
