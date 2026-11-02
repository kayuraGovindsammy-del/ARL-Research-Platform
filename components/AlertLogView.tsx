"use client";

import { useMemo, useState } from "react";
import { guidanceFor, severityRank } from "@/lib/alert-guidance";
import { formatDateTime, formatNumber, timeAgo, titleCase } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry-store";
import { alertSeverity, type AlertRecord, type AlertStatus } from "@/lib/types";
import { useNow } from "@/lib/use-now";
import { AlertActionModal, describeEvent } from "./AlertAnnunciator";
import { ReplayBar } from "./ReplayBar";
import { Badge, EmptyState, Metric, Panel, StatusDot, type Tone } from "./ui";

const STATUS_TONE: Record<AlertStatus, Tone> = {
  ACTIVE: "alert",
  ACKNOWLEDGED: "warn",
  RESOLVED: "ok",
};

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "alert",
  warning: "warn",
  info: "info",
};

const SERVICE_ORDER = ["RTA", "MHE", "OPG", "LWM"] as const;

type ActionKind = "acknowledge" | "resolve";
type StatusFilter = AlertStatus | "ALL";

/** Milliseconds between two ISO timestamps, or null when either is missing. */
function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const delta = Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta) ? delta : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${formatNumber(ms / 60_000, 1)} min`;
  return `${formatNumber(ms / 3_600_000, 1)} h`;
}

/**
 * Platform-wide alert log.
 *
 * The per-service annunciators are for the shift watching that console; this
 * page is the record. It keeps every alert the platform ever raised — with the
 * cause that fired it, who acknowledged and resolved it and when — and it is
 * the page an investigator opens afterwards to answer "what happened, and how
 * long did it stay broken?".
 *
 * The summary strip above the table is derived, not stored: median
 * acknowledgement and resolution latency, the busiest service and the rule that
 * fires most often. Those are the numbers a researcher actually wants from an
 * alert history, and a raw table cannot show them.
 */
export function AlertLogView() {
  const { alerts, counts, alertsLoading, acknowledge, resolve, mode, replayContext, error } = useTelemetry();
  const now = useNow(15_000);

  const [serviceFilter, setServiceFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [severityFilter, setSeverityFilter] = useState<string>("ALL");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<{ kind: ActionKind; alert: AlertRecord } | null>(null);

  const readOnly = mode === "replay";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return alerts
      .filter((alert) => {
        if (serviceFilter !== "ALL" && alert.service !== serviceFilter) return false;
        if (statusFilter !== "ALL" && alert.status !== statusFilter) return false;
        if (severityFilter !== "ALL" && alertSeverity(alert) !== severityFilter) return false;
        if (!needle) return true;
        return (
          alert.message.toLowerCase().includes(needle) ||
          alert.alertType.toLowerCase().includes(needle) ||
          (alert.cause ?? "").toLowerCase().includes(needle) ||
          (alert.entity ?? "").toLowerCase().includes(needle)
        );
      })
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          Date.parse(b.timestamp) - Date.parse(a.timestamp),
      );
  }, [alerts, serviceFilter, statusFilter, severityFilter, query]);

  const insight = useMemo(() => {
    const ackLatency: number[] = [];
    const resolveLatency: number[] = [];
    const perService = new Map<string, number>();
    const perRule = new Map<string, number>();

    for (const alert of alerts) {
      const ack = elapsed(alert.timestamp, alert.acknowledgedAt);
      if (ack !== null) ackLatency.push(ack);
      const fixed = elapsed(alert.timestamp, alert.resolvedAt);
      if (fixed !== null) resolveLatency.push(fixed);
      perService.set(alert.service, (perService.get(alert.service) ?? 0) + 1);
      const rule = alert.alertType.split(":")[0];
      perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
    }

    const busiest = [...perService.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const noisiest = [...perRule.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

    return {
      medianAck: median(ackLatency),
      medianResolve: median(resolveLatency),
      busiest,
      noisiest,
      ackSamples: ackLatency.length,
      resolveSamples: resolveLatency.length,
    };
  }, [alerts]);

  const unresolved = counts.ACTIVE + counts.ACKNOWLEDGED;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-console-signal">
            Platform · alert system
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-console-ink">
            Alert log & resolution record
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-console-muted">
            Every alert raised by any service, with the cause that fired it and the
            acknowledge/resolve audit trail. The annunciators on each console show what is live now;
            this page is the record you investigate later.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={counts.ACTIVE > 0 ? "alert" : "ok"}>
            <StatusDot tone={counts.ACTIVE > 0 ? "alert" : "ok"} pulse={counts.ACTIVE > 0} />
            {counts.ACTIVE} active
          </Badge>
          <Badge tone={counts.ACKNOWLEDGED > 0 ? "warn" : "neutral"}>
            {counts.ACKNOWLEDGED} acknowledged
          </Badge>
          <Badge tone="neutral">{counts.RESOLVED} resolved</Badge>
          {readOnly && <Badge tone="warn">replay</Badge>}
          {error && <Badge tone="warn">sync issue</Badge>}
        </div>
      </header>

      <ReplayBar />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          label="Unresolved"
          value={unresolved}
          hint="active + acknowledged"
          tone={unresolved > 0 ? "alert" : "ok"}
        />
        <Metric
          label="Median ack"
          value={formatDuration(insight.medianAck)}
          hint={`${insight.ackSamples} acked`}
          tone={insight.medianAck !== null && insight.medianAck > 10 * 60_000 ? "warn" : "neutral"}
        />
        <Metric
          label="Median resolve"
          value={formatDuration(insight.medianResolve)}
          hint={`${insight.resolveSamples} resolved`}
        />
        <Metric
          label="Busiest service"
          value={insight.busiest ? insight.busiest[0] : "—"}
          hint={insight.busiest ? `${insight.busiest[1]} alerts` : "none recorded"}
        />
        <Metric
          label="Noisiest rule"
          value={insight.noisiest ? titleCase(insight.noisiest[0]) : "—"}
          hint={insight.noisiest ? `${insight.noisiest[1]} firings` : "none recorded"}
        />
      </div>

      <Panel
        title="Alert records"
        subtitle="Filtered and sorted worst-first; acknowledged and resolved rows keep their operator and timestamps."
        actions={<Badge tone="neutral">{filtered.length} shown</Badge>}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="alert-service">
              Service
            </label>
            <select
              id="alert-service"
              className="input py-1 text-[11px]"
              value={serviceFilter}
              onChange={(event) => setServiceFilter(event.target.value)}
            >
              <option value="ALL">All services</option>
              {SERVICE_ORDER.map((service) => (
                <option key={service} value={service}>
                  {service}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="alert-status">
              Status
            </label>
            <select
              id="alert-status"
              className="input py-1 text-[11px]"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="ALL">All</option>
              <option value="ACTIVE">Active</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="RESOLVED">Resolved</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="alert-severity">
              Severity
            </label>
            <select
              id="alert-severity"
              className="input py-1 text-[11px]"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
            >
              <option value="ALL">All</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div className="min-w-[180px] flex-1">
            <label className="label" htmlFor="alert-search">
              Search
            </label>
            <input
              id="alert-search"
              className="input py-1 text-[11px]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="message, rule, cause or entity"
            />
          </div>
        </div>

        <div className="mt-3 overflow-x-auto">
          {filtered.length === 0 ? (
            <EmptyState
              message={alertsLoading ? "Loading alerts…" : "No alerts match these filters."}
              hint={
                alerts.length === 0
                  ? "Nothing has breached a monitored threshold yet."
                  : `${alerts.length} alert(s) on record.`
              }
            />
          ) : (
            <table className="w-full min-w-[980px] border-collapse text-left text-[11px]">
              <thead>
                <tr className="border-b border-console-edge/70 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                  <th className="py-1.5 pr-2 font-medium">Raised</th>
                  <th className="py-1.5 pr-2 font-medium">Service</th>
                  <th className="py-1.5 pr-2 font-medium">Severity</th>
                  <th className="py-1.5 pr-2 font-medium">Cause</th>
                  <th className="py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5 pr-2 font-medium">Acknowledged</th>
                  <th className="py-1.5 pr-2 font-medium">Resolved</th>
                  <th className="py-1.5 pr-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((alert) => {
                  const severity = alertSeverity(alert);
                  const guidance = guidanceFor(alert.alertType, alert.service);
                  return (
                    <tr
                      key={alert.id}
                      className="border-b border-console-edge/40 align-top last:border-b-0"
                    >
                      <td className="py-2 pr-2 font-mono text-console-muted">
                        <span title={formatDateTime(alert.timestamp)}>{timeAgo(alert.timestamp, now)}</span>
                        <span className="block text-[10px] text-console-muted/70">
                          {formatDateTime(alert.timestamp).slice(5, 19)}
                        </span>
                      </td>
                      <td className="py-2 pr-2 font-mono uppercase tracking-[0.1em] text-console-info">
                        {alert.service}
                      </td>
                      <td className="py-2 pr-2">
                        <Badge tone={SEVERITY_TONE[severity] ?? "warn"}>{severity}</Badge>
                      </td>
                      <td className="max-w-[320px] py-2 pr-2">
                        <p className="text-console-ink">{alert.message}</p>
                        <p className="mt-0.5 text-[10px] text-console-muted">
                          {alert.cause?.trim() ? alert.cause : alert.alertType}
                          {alert.entity ? ` · ${alert.entity}` : ""}
                        </p>
                        {alert.status !== "RESOLVED" && (
                          <p className="mt-0.5 text-[10px] text-console-info">do — {guidance.action}</p>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <Badge tone={STATUS_TONE[alert.status]}>
                          <StatusDot tone={STATUS_TONE[alert.status]} pulse={alert.status === "ACTIVE"} />
                          {alert.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2 text-console-muted">
                        {alert.acknowledgedBy ? (
                          <>
                            <span className="text-console-ink">{alert.acknowledgedBy}</span>
                            <span className="block font-mono text-[10px]">
                              {formatDateTime(alert.acknowledgedAt)}
                            </span>
                            <span className="block font-mono text-[10px] text-console-muted/70">
                              in {formatDuration(elapsed(alert.timestamp, alert.acknowledgedAt))}
                            </span>
                          </>
                        ) : alert.status === "RESOLVED" ? (
                          // The service cleared it before an operator saw it. Say so
                          // rather than leaving a blank that reads like lost data.
                          <span className="text-[10px]">
                            not acknowledged — cleared by {alert.service} first
                          </span>
                        ) : (
                          <span className="text-[10px]">awaiting operator</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-console-muted">
                        {alert.resolvedBy ? (
                          <>
                            <span className="text-console-ink">{alert.resolvedBy}</span>
                            <span className="block font-mono text-[10px]">
                              {formatDateTime(alert.resolvedAt)}
                            </span>
                            <span className="block font-mono text-[10px] text-console-muted/70">
                              in {formatDuration(elapsed(alert.timestamp, alert.resolvedAt))}
                            </span>
                            {alert.resolutionNote && (
                              <span className="mt-0.5 block max-w-[220px] text-[10px] text-console-muted">
                                {alert.resolutionNote}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {readOnly || alert.status === "RESOLVED" ? (
                          <span className="text-[10px] text-console-muted/70">
                            {readOnly ? "read-only in replay" : "closed"}
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {alert.status === "ACTIVE" && (
                              <button
                                type="button"
                                className="btn btn-warn px-2 py-0.5 text-[10px]"
                                onClick={() => setAction({ kind: "acknowledge", alert })}
                              >
                                Acknowledge
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn px-2 py-0.5 text-[10px]"
                              onClick={() => setAction({ kind: "resolve", alert })}
                            >
                              Resolve
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {filtered.length > 200 && (
          <p className="mt-2 text-[10px] text-console-muted">
            Showing the 200 most severe of {filtered.length} matching alerts — narrow the filters to see
            the rest.
          </p>
        )}
      </Panel>

      {readOnly && replayContext && (
        <Panel
          title="Service events at this point"
          subtitle={`Everything published under events/ in the ${Math.round(
            replayContext.windowMs / 60000,
          )} minutes before the replay cursor.`}
        >
          {replayContext.events.length === 0 ? (
            <EmptyState message="No service events in this window." />
          ) : (
            <ul className="divide-y divide-console-edge/40">
              {replayContext.events.slice(-12).reverse().map((event, index) => (
                <li
                  key={`${event.timestamp}-${event.kind}-${index}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 text-[11px]"
                >
                  <span className="font-mono text-console-muted">
                    {formatDateTime(event.timestamp).slice(11, 19)}
                  </span>
                  <span className="font-mono uppercase tracking-[0.12em] text-console-info">
                    {event.service}
                  </span>
                  <span className="text-console-ink">{event.kind}</span>
                  <span className="truncate text-console-muted">{describeEvent(event)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
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
    </div>
  );
}
