import { AlertOperationError, writeAuditLog } from "./alerts";
import { prisma } from "./prisma";
import { checkCommandPermission, type AuthVerdict } from "./researcher-auth";
import { isService } from "./types";

/**
 * Alert handling authorisation.
 *
 * The spec ties every alert to the service it came from and requires it to be
 * "handled by a researcher with access to that component". Acknowledge and
 * resolve are state changes on that component's alert stream, so they go
 * through the same experiment entitlement that gates commands — the ARL API's
 * verdict for `(code, service)`, cached by `checkCommandPermission`.
 *
 * Fail-open matches the command path: if the ARL API is unreachable the action
 * is allowed and the response carries `auth.source: "unavailable"`, so a REST
 * outage cannot leave a critical alert unattended. A denial is written to the
 * audit log before the 403 is returned, so an attempt shows up in the record
 * even though the alert itself was not touched.
 */

export class AlertAuthError extends AlertOperationError {
  reason = "researcher_not_permitted";
}

export interface AlertAuthorisation {
  /** The alert's service, or null when the id does not exist (404 comes later). */
  service: string | null;
  /** Null when the alert is not scoped to an experiment (nothing to check). */
  auth: AuthVerdict | null;
}

export async function authoriseAlertAction(
  alertId: string,
  researcher: string,
): Promise<AlertAuthorisation> {
  const row = await prisma.alert.findUnique({
    where: { id: alertId },
    select: { service: true },
  });
  // A missing alert is reported by the lifecycle call with a 404.
  if (!row) return { service: null, auth: null };

  const service = row.service;
  // Platform rules are recorded against the service whose silence tripped them,
  // so every row currently has an experiment scope. Guard anyway rather than
  // casting a future "PLATFORM" value into the Service union.
  if (!isService(service)) return { service, auth: null };

  const auth = await checkCommandPermission(researcher, service);
  if (auth.allowed) return { service, auth };

  await writeAuditLog(
    "ALERT_DENIED",
    researcher || "(none)",
    `Alert ${alertId} (${service}) acknowledge/resolve denied — ${auth.reason}`,
  );
  throw new AlertAuthError(auth.reason, 403);
}
