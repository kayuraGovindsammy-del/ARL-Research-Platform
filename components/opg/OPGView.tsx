"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchPowerHistory, type TopicWindow } from "@/lib/api-client";
import { formatDateTime, formatNumber, formatTime, timeAgo, titleCase } from "@/lib/format";
import {
  computeTotals,
  deriveOpgAlerts,
  getPower,
  getSources,
  toCombinedTrendPoint,
  toTrendPoint,
  type TrendPoint,
} from "@/lib/opg-selectors";
import { useTelemetry } from "@/lib/telemetry-store";
import { SERVICE_ACCENT } from "@/lib/theme";
import {
  OPG_BATTERY_CRITICAL_PCT,
  OPG_DIESEL_LOW_FUEL_PCT,
  type GenerationPriority,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useNow } from "@/lib/use-now";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
import { ServiceHeader } from "../ServiceHeader";
import { ConfirmButton } from "../ConfirmButton";
import { InsightPanel } from "../InsightPanel";
import { PermissionNote } from "../PermissionNote";
import { PresetPanel } from "../PresetPanel";
import { ReplayBar } from "../ReplayBar";
import { Badge, EmptyState, Metric, Panel, ProgressBar, StatusDot } from "../ui";
import { Gauge } from "./Gauge";

const INVERTER_TONE: Record<string, "ok" | "warn" | "alert" | "neutral"> = {
  ONLINE: "ok",
  STANDBY: "warn",
  OFFLINE: "alert",
  FAULT: "alert",
};

const PRIORITY_LABEL: Record<GenerationPriority, string> = {
  solar_first: "Solar first",
  battery_first: "Battery first",
  diesel_first: "Diesel first",
};

export function OPGView() {
  const { topics, mode, cursorMs, windowMinutes, lastTelemetryAt } = useTelemetry();
  const { operator, setOperator } = useOperator();
  const { run, pending, feedback } = useCommandRunner();
  const now = useNow(30_000);
  /** Replay anchors the trend window to the cursor instead of the live edge. */
  const replayAnchor = mode === "replay" ? cursorMs : null;
  const windowLabel = windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`;

  const power = useMemo(() => getPower(topics), [topics]);
  const state = power?.state ?? null;
  const totals = useMemo(() => computeTotals(state), [state]);
  const sources = useMemo(() => getSources(topics), [topics]);
  const derivedAlerts = useMemo(() => deriveOpgAlerts(state, totals), [state, totals]);

  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyWindow, setHistoryWindow] = useState<TopicWindow | null>(null);
  /**
   * The reserve draft is seeded once from whatever the batteries publish, so a
   * telemetry tick never rewrites the value the operator is dragging. The
   * label below always shows current vs. target, which is what matters.
   */
  const [reserveDraft, setReserveDraft] = useState(30);
  const reserveSeeded = useRef(false);
  const publishedReserve = state?.batteryReservePct ?? null;
  useEffect(() => {
    if (reserveSeeded.current || typeof publishedReserve !== "number") return;
    reserveSeeded.current = true;
    setReserveDraft(Math.round(publishedReserve));
  }, [publishedReserve]);

  useEffect(() => {
    let cancelled = false;
    // Re-anchored whenever the window size or the replay cursor moves, so the
    // chart always describes the moment the rest of the console is showing.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchPowerHistory(windowMinutes, replayAnchor);
          if (cancelled) return;
          setTrend(
            response.samples
              .map((sample) => toTrendPoint(sample.payload, sample.timestamp))
              .filter((point) => Number.isFinite(point.t))
              .sort((a, b) => a.t - b.t)
              .slice(-720),
          );
          setHistoryWindow(response.available);
          setHistoryError(null);
        } catch (caught) {
          if (!cancelled) setHistoryError(caught instanceof Error ? caught.message : String(caught));
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [windowMinutes, replayAnchor]);

  const powerTimestamp = power?.timestamp ?? null;
  useEffect(() => {
    if (!power || mode === "replay") return;
    // Live only: in replay the history query already brackets the cursor, and
    // appending snapshot samples would leave points from later in the replay.
    const point = toCombinedTrendPoint(power.state, power.timestamp);
    setTrend((previous) => {
      const next = [...previous.filter((entry) => entry.t !== point.t), point].sort((a, b) => a.t - b.t);
      return next.slice(-720);
    });
  }, [power, powerTimestamp, mode]);

  const supplyMode = (state?.supplyMode ?? "").toString().toUpperCase();
  const priority = (state?.generationPriority ?? "").toString();
  const inverterStatus = (state?.inverterStatus ?? "").toString().toUpperCase();
  const generatorRunning = state?.generatorStatus === "running";
  const loadPct =
    totals.demandKw > 0 ? Math.min((totals.producedKw / totals.demandKw) * 100, 200) : null;
  const solarShare = totals.producedKw > 0 ? (totals.solarKw / totals.producedKw) * 100 : null;

  /**
   * The answer this console commits to: can the plant carry the load without
   * burning diesel? Everything below the panel is the evidence behind it.
   */
  const reserveTargetPct = publishedReserve;
  const reserveShortfallPct =
    totals.batteryPct !== null && reserveTargetPct !== null ? totals.batteryPct - reserveTargetPct : null;
  const insightTone: "ok" | "warn" | "alert" =
    totals.deficitKw > 0
      ? "alert"
      : (totals.batteryPct !== null && totals.batteryPct <= OPG_BATTERY_CRITICAL_PCT) ||
          (totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT) ||
          (reserveShortfallPct !== null && reserveShortfallPct < 0)
        ? "warn"
        : "ok";
  const insightAnswer =
    totals.deficitKw > 0
      ? `No — the plant is ${formatNumber(totals.deficitKw, 1)} kW short of the ${formatNumber(
          totals.demandKw,
          1,
        )} kW load. ${generatorRunning ? "Diesel is carrying the gap." : "Shed load or start a generator."}`
      : `Yes — ${formatNumber(totals.producedKw, 1)} kW covers the ${formatNumber(totals.demandKw, 1)} kW load. ${
          reserveShortfallPct !== null && reserveShortfallPct < 0
            ? `The store is ${formatNumber(Math.abs(reserveShortfallPct), 0)} points below the ${formatNumber(
                reserveTargetPct ?? 0,
                0,
              )} % reserve you set, so diesel is the only margin left.`
            : reserveShortfallPct !== null
              ? `The store is ${formatNumber(reserveShortfallPct, 0)} points above your ${formatNumber(
                  reserveTargetPct ?? 0,
                  0,
                )} % reserve.`
              : "Battery reserve is not published, so the remaining margin is unknown."
        }`;

  const issue = (control: string, entity: string, value: unknown, label: string) =>
    run({ service: "OPG", entity, control, value, researcher: operator }, label);

  /**
   * An empty trend is normally a replay window that starts before the recording
   * does, so name the recorded range rather than just "no history".
   */
  const historyHint =
    historyError ??
    (historyWindow && historyWindow.samples > 0
      ? `Power is recorded from ${formatDateTime(historyWindow.earliest)} to ${formatDateTime(
          historyWindow.latest,
        )} — this window ends before the first sample.`
      : "Samples are recorded as soon as the OPG controller publishes.");

  return (
    <div
      className="accent-scope space-y-4"
      style={{ "--accent": SERVICE_ACCENT.OPG } as React.CSSProperties}
    >
      <ServiceHeader
        index="03"
        service="On-Demand Power Generation"
        title="Plant generation & load control"
        blurb="Solar, battery store and diesel backup for the whole laboratory, with source switching and load-shedding authority."
        accent="#8ab4ff"
        status={
          <div className="flex flex-wrap items-center gap-2">
          <Badge tone={totals.deficitKw > 0 ? "alert" : "ok"}>
            <StatusDot tone={totals.deficitKw > 0 ? "alert" : "ok"} pulse={totals.deficitKw > 0} />
            {totals.deficitKw > 0 ? `${formatNumber(totals.deficitKw, 1)} kW deficit` : "demand covered"}
          </Badge>
          <Badge tone="info">supply {supplyMode || "—"}</Badge>
          {state?.loadShed && <Badge tone="warn">load shedding</Badge>}
          <Badge tone="neutral">last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt, now) : "—"}</Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
          </div>
        }
      />

      <ReplayBar service="OPG" />

      <PermissionNote service="OPG" code={operator} />

      {derivedAlerts.length > 0 && (
        <div className="panel border-console-warn/40 bg-console-warn/5 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {derivedAlerts.map((alert) => (
              <span
                key={alert.message}
                className={`flex items-center gap-2 text-xs ${
                  alert.tone === "alert" ? "text-console-alert" : "text-console-warn"
                }`}
              >
                <StatusDot tone={alert.tone} pulse />
                {alert.message}
              </span>
            ))}
          </div>
        </div>
      )}

      <InsightPanel
        question="Can the plant carry the load without starting a diesel generator?"
        tone={insightTone}
        answer={insightAnswer}
        evidence={[
          {
            label: "Output vs demand",
            value: `${formatNumber(totals.producedKw, 1)} / ${formatNumber(totals.demandKw, 1)} kW`,
            percent: loadPct === null ? 0 : Math.round(Math.min(loadPct, 100)),
            tone: totals.deficitKw > 0 ? "alert" : "ok",
            hint:
              totals.deficitKw > 0
                ? `${formatNumber(totals.deficitKw, 1)} kW short`
                : `${formatNumber(Math.max(totals.producedKw - totals.demandKw, 0), 1)} kW spare`,
          },
          {
            label: "Battery store",
            value: totals.batteryPct === null ? "—" : `${formatNumber(totals.batteryPct, 1)} %`,
            percent: totals.batteryPct === null ? 0 : Math.round(totals.batteryPct),
            tone:
              totals.batteryPct !== null && totals.batteryPct <= OPG_BATTERY_CRITICAL_PCT
                ? "alert"
                : reserveShortfallPct !== null && reserveShortfallPct < 0
                  ? "warn"
                  : "signal",
            hint:
              reserveTargetPct === null
                ? "no reserve target set"
                : `target ${formatNumber(reserveTargetPct, 0)} %`,
          },
          {
            label: "Solar share",
            value: solarShare === null ? "—" : `${formatNumber(solarShare, 0)} %`,
            percent: solarShare === null ? 0 : Math.round(Math.min(solarShare, 100)),
            tone: "signal",
            hint: `${formatNumber(totals.solarKw, 1)} of ${formatNumber(totals.producedKw, 1)} kW`,
          },
          {
            label: "Diesel fuel",
            value: totals.fuelPct === null ? "—" : `${formatNumber(totals.fuelPct, 1)} %`,
            percent: totals.fuelPct === null ? 0 : Math.round(totals.fuelPct),
            tone:
              totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT ? "alert" : "warn",
            hint: generatorRunning
              ? `running, ${formatNumber(totals.dieselKw, 1)} kW`
              : "generator stopped",
          },
        ]}
        footnote="Coverage is derived from the aggregated power topic; the store, fuel and reserve figures come from plant state, so the answer is only as fresh as the last telemetry tick."
      />

      <Panel
        title="Power generation overview"
        subtitle={`Aggregated plant state ${power ? `updated ${timeAgo(power.timestamp, now)}` : "— no telemetry"}`}
        actions={
          <Badge tone={INVERTER_TONE[inverterStatus] ?? "neutral"}>
            inverter {inverterStatus || "unknown"}
          </Badge>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Metric
            label="Total produced"
            value={formatNumber(totals.producedKw, 1)}
            unit="kW"
            hint={`${formatNumber(totals.demandKw, 1)} kW consumed`}
            tone={totals.deficitKw > 0 ? "alert" : "ok"}
          />
          <Metric
            label="Solar output"
            value={formatNumber(totals.solarKw, 1)}
            unit="kW"
            hint={
              state?.irradianceWm2 !== null && state?.irradianceWm2 !== undefined
                ? `${formatNumber(state.irradianceWm2, 0)} W/m² · ${formatNumber(solarShare, 0)}% share`
                : `share ${formatNumber(solarShare, 0)}%`
            }
            tone={state?.solarEnabled === false ? "warn" : "neutral"}
          />
          <Metric
            label="Battery reserve"
            value={formatNumber(totals.batteryPct, 1)}
            unit="%"
            hint={`${formatNumber(Math.abs(totals.batteryKw), 1)} kW ${totals.batteryKw >= 0 ? "discharge" : "charge"}`}
            tone={
              totals.batteryPct !== null && totals.batteryPct <= OPG_BATTERY_CRITICAL_PCT ? "alert" : "neutral"
            }
          />
          <Metric
            label="Diesel output"
            value={formatNumber(totals.dieselKw, 1)}
            unit="kW"
            hint={generatorRunning ? "generator running" : "generator stopped"}
            tone={generatorRunning ? "warn" : "neutral"}
          />
          <Metric
            label="Diesel fuel"
            value={formatNumber(totals.fuelPct, 1)}
            unit="%"
            tone={totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT ? "alert" : "neutral"}
          />
          <Metric
            label="Load shedding"
            value={state?.loadShed ? "ENGAGED" : "NORMAL"}
            hint={
              state?.loadShed
                ? `${formatNumber(totals.demandKw, 1)} kW total load`
                : "no loads shed"
            }
            tone={state?.loadShed ? "warn" : "ok"}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-console-muted">Demand coverage</span>
          <div className="min-w-[180px] flex-1">
            <ProgressBar
              value={loadPct ?? 0}
              max={100}
              tone={totals.deficitKw > 0 ? "alert" : (loadPct ?? 0) > 90 ? "warn" : "ok"}
            />
          </div>
          <span className="font-mono text-[11px] text-console-ink">{formatNumber(loadPct, 0)}%</span>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title="Generation vs demand"
            subtitle={
              mode === "replay"
                ? `${windowLabel} of plant samples ending at the replay cursor (${formatTime(
                    new Date(cursorMs).toISOString(),
                  )}).`
                : `Last ${windowLabel} of aggregated plant samples.`
            }
            actions={
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                <span className="text-console-solar">solar</span>
                <span className="text-console-warn">diesel</span>
                <span className="text-console-info">demand</span>
              </div>
            }
          >
            <div className="h-56 w-full">
              {trend.length === 0 ? (
                <EmptyState
                  message="No power history yet."
                  hint={historyHint}
                />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trend} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="#33231d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      scale="time"
                      tickFormatter={(value) => formatTime(new Date(Number(value)).toISOString())}
                      stroke="#a89285"
                      tick={{ fontSize: 10, fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
                      minTickGap={28}
                    />
                    <YAxis
                      stroke="#a89285"
                      tick={{ fontSize: 10, fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
                      width={48}
                      unit=" kW"
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#140f0d",
                        border: "1px solid #33231d",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                      labelFormatter={(value) => formatTime(new Date(Number(value)).toISOString())}
                    />
                    <Area
                      type="monotone"
                      dataKey="solarKw"
                      name="Solar kW"
                      stroke="#ffc978"
                      fill="#ffc978"
                      fillOpacity={0.18}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="dieselKw"
                      name="Diesel kW"
                      stroke="#ffa14b"
                      fill="#ffa14b"
                      fillOpacity={0.14}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="demandKw"
                      name="Demand kW"
                      stroke="#8ab4ff"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-console-muted">
              {mode === "replay" ? "cursor sample" : "current sample"}{" "}
              {power?.timestamp ? formatTime(power.timestamp) : "—"} · {trend.length} points
              {trend.length > 1 && (
                <>
                  {" "}
                  · output {formatNumber(trend[0].solarKw + trend[0].dieselKw, 1)} →{" "}
                  {formatNumber(trend[trend.length - 1].solarKw + trend[trend.length - 1].dieselKw, 1)} kW
                </>
              )}
            </p>
          </Panel>

          <Panel
            title="Source status"
            subtitle="Per-source controller streams on arl/opg/{solar,batteries,diesel}/telemetry/power."
          >
            {sources.length === 0 ? (
              <EmptyState message="No per-source status yet." hint="Derived totals from the aggregated power topic are still shown above." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-console-edge/70 text-[10px] uppercase tracking-[0.14em] text-console-muted">
                      <th className="table-cell">Source</th>
                      <th className="table-cell">State</th>
                      <th className="table-cell">Output</th>
                      <th className="table-cell">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((source) => (
                      <tr key={source.source} className="border-b border-console-edge/40 last:border-b-0">
                        <td className="table-cell text-console-ink">{titleCase(source.source)}</td>
                        <td className="table-cell">
                          <Badge tone={source.online ? "ok" : "alert"}>{source.online ? "online" : "offline"}</Badge>
                        </td>
                        <td className="table-cell">{formatNumber(source.outputKw, 1)} kW</td>
                        <td className="table-cell text-console-muted">{timeAgo(source.timestamp, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Source mix" subtitle="Contribution of each generator to the current output.">
            <div className="space-y-2">
              {[
                { label: "Solar array", value: Math.max(totals.solarKw, 0), tone: "signal" as const },
                { label: "Diesel generators", value: Math.max(totals.dieselKw, 0), tone: "warn" as const },
                { label: "Battery discharge", value: Math.max(totals.batteryKw, 0), tone: "info" as const },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2">
                  <span className="w-36 text-[10px] uppercase tracking-[0.12em] text-console-muted">{row.label}</span>
                  <div className="flex-1">
                    <ProgressBar value={row.value} max={Math.max(totals.producedKw, 1)} tone={row.tone} />
                  </div>
                  <span className="w-16 text-right font-mono text-[11px] text-console-ink">
                    {formatNumber(row.value, 1)} kW
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Reserve & generation gauges" subtitle="Battery, load coverage and fuel reserve.">
            <div className="grid grid-cols-2 gap-2">
              <Gauge
                value={totals.batteryPct}
                label="Battery"
                tone={
                  totals.batteryPct !== null && totals.batteryPct <= OPG_BATTERY_CRITICAL_PCT ? "alert" : "signal"
                }
                caption="reserve capacity"
              />
              <Gauge
                value={loadPct}
                max={150}
                unit="%"
                label="Coverage"
                tone={totals.deficitKw > 0 ? "alert" : "ok"}
                caption="demand covered"
              />
              <Gauge
                value={totals.fuelPct}
                label="Fuel"
                tone={totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT ? "alert" : "warn"}
                caption="diesel reserve"
              />
              <Gauge value={solarShare} label="Solar" tone="solar" caption="share of output" />
            </div>
          </Panel>

          <PresetPanel
            service="OPG"
            operator={operator}
            run={run}
            pending={pending}
            title="Plant presets"
          />

          <Panel title="Power controls" subtitle="Commands are published to arl/opg/cmd/… and audited.">
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="opg-operator">
                  Operator
                </label>
                <input
                  id="opg-operator"
                  className="input"
                  value={operator}
                  onChange={(event) => setOperator(event.target.value)}
                  placeholder="Researcher name / ID"
                />
              </div>

              <div>
                <span className="label">Generation priority</span>
                <div className="grid grid-cols-3 gap-1">
                  {(Object.keys(PRIORITY_LABEL) as GenerationPriority[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`btn ${priority === option ? "btn-primary" : ""}`}
                      disabled={pending !== null || priority === option}
                      onClick={() =>
                        void issue(
                          "generation_priority",
                          "global",
                          option,
                          `Set ${PRIORITY_LABEL[option].toLowerCase()}`,
                        )
                      }
                    >
                      {option.split("_")[0]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="label" htmlFor="opg-reserve">
                  Battery reserve — target {reserveDraft} % (now{" "}
                  {formatNumber(publishedReserve, 0)} %)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="opg-reserve"
                    type="range"
                    min={10}
                    max={80}
                    step={5}
                    value={reserveDraft}
                    onChange={(event) => setReserveDraft(Number(event.target.value))}
                    className="scrubber flex-1"
                    disabled={pending !== null}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      pending !== null ||
                      (typeof publishedReserve === "number" &&
                        Math.round(publishedReserve) === reserveDraft)
                    }
                    onClick={() =>
                      void issue("battery_reserve", "batteries", reserveDraft, `Reserve ${reserveDraft} %`)
                    }
                  >
                    Apply
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-console-muted">
                  Below the reserve the plant stops drawing the battery and leans on diesel instead.
                  Allowed 10–80 %.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <ConfirmButton
                  label="Shed loads"
                  impact={
                    state?.loadShed
                      ? "Load shedding is already engaged."
                      : `Shedding removes non-essential laboratory loads (currently ${formatNumber(
                          totals.demandKw,
                          1,
                        )} kW of demand) until they are released. Habitat and experiment-critical circuits stay on, but anything classified as non-essential stops immediately and without a cool-down.`
                  }
                  confirmLabel="Shed non-essential loads"
                  disabled={pending !== null || state?.loadShed === true}
                  className={`btn ${state?.loadShed ? "btn-warn" : ""}`}
                  onConfirm={() => void issue("load_shed", "global", true, "Engage load shedding")}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={pending !== null || state?.loadShed !== true}
                  onClick={() => void issue("load_shed", "global", false, "Release load shedding")}
                >
                  Release loads
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pending !== null || state?.solarEnabled === true}
                  onClick={() => void issue("enable_solar_array", "solar", true, "Enable solar array")}
                >
                  Enable solar
                </button>
                <ConfirmButton
                  label="Disable solar"
                  impact={`Disabling the array removes ${formatNumber(
                    totals.solarKw,
                    1,
                  )} kW of generation and shifts the shortfall onto the battery store and diesel backup. If neither can cover demand the plant will start load shedding on its own.`}
                  confirmLabel="Disable solar array"
                  disabled={pending !== null || state?.solarEnabled === false}
                  className="btn btn-warn"
                  onConfirm={() => void issue("enable_solar_array", "solar", false, "Disable solar array")}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending !== null || generatorRunning}
                  onClick={() => void issue("start_generator", "diesel", true, "Start diesel generator")}
                >
                  Start diesel
                </button>
                <ConfirmButton
                  label="Stop diesel"
                  impact="Stopping the generator begins a 60 s cool-down, after which the array and battery store must carry the full load. Stop it only when another source already covers demand."
                  confirmLabel="Stop generator"
                  disabled={pending !== null || !generatorRunning}
                  className="btn btn-danger"
                  onConfirm={() => void issue("stop_generator", "diesel", true, "Stop diesel generator")}
                />
              </div>

              {feedback && (
                <p
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] ${
                    feedback.tone === "ok"
                      ? "border-console-ok/40 bg-console-ok/10 text-console-ok"
                      : "border-console-alert/50 bg-console-alert/10 text-console-alert"
                  }`}
                >
                  {feedback.text}
                </p>
              )}

              <p className="text-[10px] text-console-muted">
                Priority {priority || "—"} · load shedding {state?.loadShed ? "engaged" : "off"} · solar{" "}
                {state?.solarEnabled === false ? "disabled" : "enabled"} · diesel{" "}
                {generatorRunning ? "running" : "stopped"} · inverter {inverterStatus || "unknown"} ·
                reserve {formatNumber(publishedReserve, 0)} %
              </p>
            </div>
          </Panel>

          <AlertAnnunciator title="Annunciator · OPG alerts" maxHeight="max-h-[420px]" />
        </div>
      </div>
    </div>
  );
}
