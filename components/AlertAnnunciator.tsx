"use client";

import { useEffect, useMemo, useState } from "react";
import { guidanceFor, severityRank } from "@/lib/alert-guidance";
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { useTelemetry, type ServiceEvent } from "@/lib/telemetry-store";
import { THEME } from "@/lib/theme";
import { alertSeverity, type AlertRecord, type AlertStatus } from "@/lib/types";
import { Badge, EmptyState, Modal, Panel, StatusDot, toneAccent, type Tone } from "./ui";

const STATUS_TONE: Record<AlertStatus, Tone> = {
  ACTIVE: "alert",
  ACKNOWLEDGED: "warn",
  RESOLVED: "ok",
};

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "alert",
  warning: "warn",
  warn: "warn",
  info: "info",
};

type Tab = AlertStatus | "ALL";
type ActionKind = "acknowledge" | "resolve";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatMeasure(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit ? ` ${unit}` : ""}`;
}

/**
 * The measurement that breached the rule, as a proportion of its limit, so the
 * annunciator shows how far out of band the alert is rather than only that it
 * fired.
 */
function LimitBar({ alert }: { alert: AlertRecord }) {
  if (alert.value === null || alert.limitValue === null || alert.limitValue === 0) return null;
  const percent = Math.min(Math.max((alert.value / alert.limitValue) * 100, 0), 100);
  const over = alert.value > alert.limitValue;
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-console-muted">
        <span className={over ? "text-console-alert" : "text-console-warn"}>
          {formatMeasure(alert.value, alert.unit)}
        </span>
        <span>limit {formatMeasure(alert.limitValue, alert.unit)}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-console-grid">
        <div
          className={`h-full rounded-full ${over ? "bg-console-alert" : "bg-console-warn"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function AlertRow({
  alert,
  now,
  readOnly,
  onAction,
}: {
  alert: AlertRecord;
  now: number;
  readOnly: boolean;
  onAction: (kind: ActionKind, alert: AlertRecord) => void;
}) {
  const status = alert.status;
  const severity = alertSeverity(alert);
  const severityTone = SEVERITY_TONE[severity] ?? "warn";
  const guidance = guidanceFor(alert.alertType, alert.service);
  return (
    <li className="relative border-b border-console-edge/50 py-2.5 pl-4 pr-3 last:border-b-0">
      {/* Severity stripe: the worst rows read as hot even before the badges are. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{
          background: `linear-gradient(180deg, ${toneAccent[severityTone]}, transparent 92%)`,
          opacity: status === "RESOLVED" ? 0.28 : 0.95,
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[status]}>
          <StatusDot tone={STATUS_TONE[status]} pulse={status === "ACTIVE"} />
          {status}
        </Badge>
        <Badge tone={severityTone}>{severity}</Badge>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-console-info">
          {alert.service}
        </span>
        <span className="font-mono text-[10px] text-console-muted">{alert.alertType.split(":")[0]}</span>
        <span className="ml-auto font-mono text-[10px] text-console-muted" title={formatDateTime(alert.timestamp)}>
          {timeAgo(alert.timestamp, now)}
        </span>
      </div>

      <p className="mt-1.5 text-sm leading-snug text-console-ink">{alert.message}</p>

      {/* Cause: the rule, the entity and the value that breached the limit. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-console-muted">
          <span className="uppercase tracking-[0.12em] text-console-warn">cause</span> —{" "}
          {/* An alert raised by an older build can have a blank cause; the rule
              behind it is still the honest answer, so never leave the line empty. */}
          <span className="text-console-ink">
            {alert.cause?.trim() ? alert.cause : alert.alertType}
          </span>
        </span>
        {alert.entity && (
          <span className="font-mono text-console-muted">{alert.entity}</span>
        )}
      </div>

      <LimitBar alert={alert} />

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-console-muted">
        <span title={formatDateTime(alert.timestamp)}>raised {formatDateTime(alert.timestamp)}</span>
        {alert.acknowledgedBy && (
          <span>
            acked by <span className="text-console-ink">{alert.acknowledgedBy}</span>
            {alert.acknowledgedAt ? ` · ${formatDateTime(alert.acknowledgedAt)}` : ""}
          </span>
        )}
        {alert.resolvedBy && (
          <span>
            resolved by <span className="text-console-ink">{alert.resolvedBy}</span>
            {alert.resolvedAt ? ` · ${formatDateTime(alert.resolvedAt)}` : ""}
          </span>
        )}
      </div>

      {alert.resolutionNote && (
        <p className="mt-1.5 rounded-md border border-console-edge/70 bg-console-void/50 px-2 py-1 text-[11px] text-console-muted">
          <span className="uppercase tracking-[0.12em] text-console-ok">resolution</span> — {alert.resolutionNote}
        </p>
      )}

      {status !== "RESOLVED" && (
        <p className="mt-1.5 text-[11px] leading-snug text-console-info">
          <span className="uppercase tracking-[0.12em] text-console-muted">do</span> — {guidance.action}
        </p>
      )}

      {!readOnly && status !== "RESOLVED" && (
        <div className="mt-2 flex gap-2">
          {status === "ACTIVE" && (
            <button
              type="button"
              className="btn btn-warn px-2 py-1 text-[10px]"
              onClick={() => onAction("acknowledge", alert)}
            >
              Acknowledge
            </button>
          )}
          <button
            type="button"
            className="btn px-2 py-1 text-[10px]"
            onClick={() => onAction("resolve", alert)}
          >
            Resolve
          </button>
        </div>
      )}
    </li>
  );
}

/** Compact one-line description of a service event, for the replay event strip. */
export function describeEvent(event: ServiceEvent): string {
  const payload = event.payload ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (["v", "ts", "seq", "entity", "backfill"].includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "number") {
      parts.push(`${key} ${Math.abs(value) >= 100 ? Math.round(value) : value}`);
    } else if (typeof value === "string" || typeof value === "boolean") {
      parts.push(`${key} ${String(value)}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

function EventStrip({ events }: { events: ServiceEvent[] }) {
  const recent = events.slice(-8).reverse();
  if (recent.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-console-muted">
        No service events in the 30 minutes before this point.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-console-edge/40">
      {recent.map((event, index) => (
        <li
          key={`${event.timestamp}-${event.kind}-${index}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-[11px]"
        >
          <span className="font-mono text-console-muted">{formatDateTime(event.timestamp).slice(11, 19)}</span>
          <span className="font-mono uppercase tracking-[0.12em] text-console-info">{event.service}</span>
          <span className="text-console-ink">{event.kind}</span>
          <span className="truncate text-console-muted">{describeEvent(event)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AlertActionModal({
  alert,
  kind,
  onClose,
  onSubmit,
}: {
  alert: AlertRecord;
  kind: ActionKind;
  onClose: () => void;
  onSubmit: (researcher: string, note: string) => Promise<void>;
}) {
  const [researcher, setResearcher] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isResolve = kind === "resolve";
  const guidance = guidanceFor(alert.alertType, alert.service);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (researcher.trim().length < 2) {
      setError("Enter your researcher name or ID (minimum 2 characters).");
      return;
    }
    if (isResolve && note.trim().length < 3) {
      setError("Describe the resolution (minimum 3 characters).");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(researcher.trim(), note.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={isResolve ? "Resolve alert" : "Acknowledge alert"}
      description={`${alert.service} · ${alert.alertType.split(":")[0]}`}
      onClose={onClose}
    >
      <div className="mb-4 rounded-md border border-console-edge/70 bg-console-void/50 px-3 py-2 text-xs text-console-muted">
        <p className="text-console-ink">{alert.message}</p>
        {alert.cause && <p className="mt-1">cause — {alert.cause}</p>}
        <p className="mt-1 text-console-info">suggested action — {guidance.action}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="label" htmlFor="researcher">
            Researcher name / ID <span className="text-console-alert">*</span>
          </label>
          <input
            id="researcher"
            className="input"
            value={researcher}
            onChange={(event) => setResearcher(event.target.value)}
            placeholder="e.g. Dr. A. Okafor / RA-2291"
            autoFocus
            disabled={submitting}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="note">
            {isResolve ? (
              <>
                Resolution <span className="text-console-alert">*</span>
              </>
            ) : (
              "Note (optional)"
            )}
          </label>
          <textarea
            id="note"
            className="input min-h-[90px] resize-y"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              isResolve
                ? "Actions taken, root cause, follow-up required…"
                : "Context for the next shift…"
            }
            disabled={submitting}
            required={isResolve}
          />
        </div>

        {error && (
          <p className="rounded-md border border-console-alert/50 bg-console-alert/10 px-3 py-2 text-xs text-console-alert">
            {error}
          </p>
        )}

        <p className="text-[11px] text-console-muted">
          This action is recorded in the audit log with your identity, the alert id and a timestamp.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            className={`btn ${isResolve ? "btn-primary" : "btn-warn"}`}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : isResolve ? "Confirm resolution" : "Confirm acknowledgement"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Alert annunciator panel.
 *
 * Live mode lists alerts by lifecycle state and drives the acknowledge /
 * resolve flows, collecting the operator identity and writing an AuditLog row
 * through the API.
 *
 * Replay mode shows the alerts that were live at the replay cursor — with the
 * lifecycle state each had *at that instant* — plus the service events around
 * it. Actions are disabled there: a historical alert cannot be acknowledged
 * after the fact, and pretending otherwise would corrupt the audit trail.
 */
export function AlertAnnunciator({
  className = "",
  maxHeight = "max-h-[520px]",
  title = "Alert annunciator",
}: {
  className?: string;
  maxHeight?: string;
  title?: string;
}) {
  const { alerts, counts, alertsLoading, acknowledge, resolve, mode, replayContext, cursorMs, error } =
    useTelemetry();
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [action, setAction] = useState<{ kind: ActionKind; alert: AlertRecord } | null>(null);
  const now = useNow();
  const readOnly = mode === "replay";

  const visible = useMemo(() => {
    const filtered = tab === "ALL" ? alerts : alerts.filter((alert) => alert.status === tab);
    // Worst first: a critical ACTIVE alert outranks an older warning.
    return [...filtered]
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          Date.parse(b.timestamp) - Date.parse(a.timestamp),
      )
      .slice(0, 100);
  }, [alerts, tab]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: "ACTIVE", label: "Active", count: counts.ACTIVE },
    { key: "ACKNOWLEDGED", label: "Acknowledged", count: counts.ACKNOWLEDGED },
    { key: "RESOLVED", label: "Resolved", count: counts.RESOLVED },
    {
      key: "ALL",
      label: "All",
      count: counts.ACTIVE + counts.ACKNOWLEDGED + counts.RESOLVED,
    },
  ];

  return (
    <Panel
      className={className}
      bodyClassName=""
      accent={counts.ACTIVE > 0 ? toneAccent.alert : THEME.solar}
      title={title}
      subtitle={
        readOnly
          ? `Historical view — alerts live at ${formatDateTime(new Date(cursorMs).toISOString())}, with the service events around that point.`
          : "Acknowledge and resolve with your researcher identity; every action is audited."
      }
      actions={
        <div className="flex items-center gap-2">
          {counts.ACTIVE > 0 && (
            <Badge tone="alert">
              <StatusDot tone="alert" pulse />
              {counts.ACTIVE} active
            </Badge>
          )}
          {alertsLoading && <Badge tone="info">loading</Badge>}
          {readOnly && <Badge tone="warn">replay</Badge>}
          {error && <Badge tone="warn">sync issue</Badge>}
        </div>
      }
    >
      <div className="flex flex-wrap gap-1 border-b border-console-edge/60 px-3 py-2">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors ${
              tab === entry.key
                ? "bg-console-grid text-console-ink"
                : "text-console-muted hover:text-console-ink"
            }`}
            aria-pressed={tab === entry.key}
          >
            {entry.label}
            <span className="ml-1.5 font-mono text-console-muted">{entry.count}</span>
          </button>
        ))}
      </div>

      <div className={`scroll-thin overflow-y-auto ${maxHeight}`}>
        {visible.length === 0 ? (
          <div className="p-4">
            <EmptyState
              message={
                alertsLoading
                  ? "Loading alerts…"
                  : tab === "ACTIVE"
                    ? readOnly
                      ? "No alerts were active at this point in the replay."
                      : "No active alerts. All monitored thresholds are nominal."
                    : `No ${titleCase(tab === "ALL" ? "alerts" : tab).toLowerCase()} alerts.`
              }
            />
          </div>
        ) : (
          <ul>
            {visible.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                now={now}
                readOnly={readOnly}
                onAction={(kind, target) => setAction({ kind, alert: target })}
              />
            ))}
          </ul>
        )}
      </div>

      {readOnly && replayContext && (
        <div className="border-t border-console-edge/60">
          <p className="px-3 pt-2 text-[10px] uppercase tracking-[0.14em] text-console-muted">
            Service events in the {Math.round(replayContext.windowMs / 60000)} minutes before this point
          </p>
          <EventStrip events={replayContext.events} />
        </div>
      )}

      {action && !readOnly && (
        <AlertActionModal
          key={`${action.kind}-${action.alert.id}`}
          alert={action.alert}
          kind={action.kind}
          onClose={() => setAction(null)}
          onSubmit={async (researcher, note) => {
            if (action.kind === "acknowledge") {
              await acknowledge(action.alert.id, researcher, note || undefined);
            } else {
              await resolve(action.alert.id, researcher, note);
            }
            setAction(null);
          }}
        />
      )}
    </Panel>
  );
}
