"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry-store";
import type { AlertRecord, AlertStatus } from "@/lib/types";
import { Badge, EmptyState, Modal, Panel, StatusDot, type Tone } from "./ui";

const STATUS_TONE: Record<AlertStatus, Tone> = {
  ACTIVE: "alert",
  ACKNOWLEDGED: "warn",
  RESOLVED: "ok",
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

function AlertRow({
  alert,
  now,
  onAction,
}: {
  alert: AlertRecord;
  now: number;
  onAction: (kind: ActionKind, alert: AlertRecord) => void;
}) {
  const status = alert.status;
  return (
    <li className="border-b border-console-edge/50 px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[status]}>
          <StatusDot tone={STATUS_TONE[status]} pulse={status === "ACTIVE"} />
          {status}
        </Badge>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-console-info">
          {alert.service}
        </span>
        <span className="font-mono text-[10px] text-console-muted">{alert.alertType}</span>
        <span className="ml-auto font-mono text-[10px] text-console-muted" title={formatDateTime(alert.timestamp)}>
          {timeAgo(alert.timestamp, now)}
        </span>
      </div>

      <p className="mt-1.5 text-sm leading-snug text-console-ink">{alert.message}</p>

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

function AlertActionModal({
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
      description={`${alert.service} · ${alert.alertType}`}
      onClose={onClose}
    >
      <p className="mb-4 rounded-md border border-console-edge/70 bg-console-void/50 px-3 py-2 text-xs text-console-muted">
        {alert.message}
      </p>
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
 * Lists alerts by lifecycle state and drives the acknowledge / resolve flows.
 * Both flows collect the operator identity, mutate the alert through the API
 * (which writes the AuditLog entry) and refresh the shared store.
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
  const { alerts, counts, alertsLoading, acknowledge, resolve, mode, error } = useTelemetry();
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [action, setAction] = useState<{ kind: ActionKind; alert: AlertRecord } | null>(null);
  const now = useNow();

  const visible = useMemo(() => {
    const filtered = tab === "ALL" ? alerts : alerts.filter((alert) => alert.status === tab);
    return filtered.slice(0, 100);
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
      title={title}
      subtitle={
        mode === "replay"
          ? "Showing live alert state — alerts are not replayed."
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
                    ? "No active alerts. All monitored thresholds are nominal."
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
                onAction={(kind, target) => setAction({ kind, alert: target })}
              />
            ))}
          </ul>
        )}
      </div>

      {action && (
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
