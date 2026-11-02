"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchTargets, type TargetsResponse } from "@/lib/api-client";
import { formatNumber, formatTime, timeAgo, titleCase } from "@/lib/format";
import {
  deriveRtaAlerts,
  getArrayStatus,
  getDishes,
  getLatestScanContext,
  getScanSamples,
  summarizeDishes,
} from "@/lib/rta-selectors";
import { useTelemetry } from "@/lib/telemetry-store";
import { SERVICE_ACCENT } from "@/lib/theme";
import {
  RTA_DISH_TEMP_WARN_C,
  RTA_MIN_OPERATIONAL_DISHES,
  RTA_WIND_RELEASE_MS,
  RTA_WIND_STOW_LIMIT_MS,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
import { ServiceHeader } from "../ServiceHeader";
import { ConfirmButton } from "../ConfirmButton";
import { InsightPanel } from "../InsightPanel";
import { PermissionNote } from "../PermissionNote";
import { PresetPanel } from "../PresetPanel";
import { ReplayBar } from "../ReplayBar";
import { Badge, EmptyState, Metric, Panel, ProgressBar, StatusDot } from "../ui";
import { DishGrid } from "./DishGrid";
import { DishTrendPanel } from "./DishTrendPanel";
import { ScanHeatmap } from "./ScanHeatmap";

const SCAN_TONE: Record<string, "ok" | "warn" | "alert" | "info" | "neutral"> = {
  SCANNING: "ok",
  PAUSED: "warn",
  IDLE: "info",
  SCHEDULED: "info",
  STOWED: "alert",
  CANCELLED: "alert",
  COMPLETE: "neutral",
};

export function RTAView() {
  const { topics, stream, events, lastTelemetryAt, mode } = useTelemetry();
  const { operator, setOperator } = useOperator();
  const { run, pending, feedback } = useCommandRunner();

  const [subArrayFilter, setSubArrayFilter] = useState("ALL");
  const [selectedDishId, setSelectedDishId] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetsResponse | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetingMode, setTargetingMode] = useState<"preset" | "custom">("preset");
  const [targetId, setTargetId] = useState("");
  const [customRaHours, setCustomRaHours] = useState("5.575");
  const [customDecDeg, setCustomDecDeg] = useState("-5.391");
  const [frequencyMhz, setFrequencyMhz] = useState("1420");
  const [subArrayDraft, setSubArrayDraft] = useState("main");
  const [scheduleAt, setScheduleAt] = useState("");
  const [azimuthDraft, setAzimuthDraft] = useState("180");
  const [elevationDraft, setElevationDraft] = useState("45");
  /**
   * Manual pointing drafts are seeded once per selected dish so a telemetry
   * tick never overwrites the number being typed; the panel shows the dish's
   * live aiming vector next to the target it would slew to.
   */
  const [pointingSeededFor, setPointingSeededFor] = useState<string | null>(null);

  const arrayState = useMemo(() => getArrayStatus(topics), [topics]);
  const dishes = useMemo(() => getDishes(topics), [topics]);
  const summary = useMemo(
    () => summarizeDishes(dishes, arrayState?.status ?? null),
    [dishes, arrayState],
  );

  const subArrays = useMemo(() => {
    const map = new Map<string, number>();
    for (const dish of dishes) {
      map.set(dish.subArray, (map.get(dish.subArray) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [dishes]);

  const visibleDishes = useMemo(
    () =>
      subArrayFilter === "ALL"
        ? dishes
        : dishes.filter((dish) => dish.subArray === subArrayFilter),
    [dishes, subArrayFilter],
  );

  useEffect(() => {
    if (subArrayFilter !== "ALL" && !subArrays.some(([name]) => name === subArrayFilter)) {
      setSubArrayFilter("ALL");
    }
  }, [subArrays, subArrayFilter]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetchTargets();
      if (cancelled) return;
      setTargets(response);
      setTargetsLoading(false);
      if (response.targets.length > 0) {
        setTargetId((current) => current || response.targets[0].id);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDish = useMemo(
    () => dishes.find((dish) => dish.id === selectedDishId) ?? null,
    [dishes, selectedDishId],
  );

  /**
   * The trend chart follows the selected dish, falling back to the first dish so
   * the panel is populated before anything is clicked. The topic is derived when
   * the dish has no sample yet (a cleared replay window, for instance).
   */
  const trendDishId = selectedDish?.id ?? "dish-001";
  const trendTopic = selectedDish?.topic ?? `arl/rta/${trendDishId}/telemetry/normal`;

  useEffect(() => {
    if (!selectedDish?.id || pointingSeededFor === selectedDish.id) return;
    if (selectedDish.metrics?.azimuthDeg === null || selectedDish.metrics?.azimuthDeg === undefined) return;
    setPointingSeededFor(selectedDish.id);
    setAzimuthDraft(selectedDish.metrics.azimuthDeg.toFixed(1));
    if (typeof selectedDish.metrics.elevationDeg === "number") {
      setElevationDraft(selectedDish.metrics.elevationDeg.toFixed(1));
    }
  }, [selectedDish, pointingSeededFor]);

  const scanPoints = useMemo(() => getScanSamples(stream), [stream]);
  const scanContext = useMemo(() => getLatestScanContext(events), [events]);
  const scanStatus = (arrayState?.status.status ?? "IDLE").toUpperCase();
  const scanning = scanStatus === "SCANNING";
  const derivedAlerts = useMemo(
    () => deriveRtaAlerts(summary, arrayState?.status ?? null),
    [summary, arrayState],
  );

  const activeTargetLabel =
    arrayState?.status.targetName ?? arrayState?.status.targetId ?? "none";
  const windStow = arrayState?.status.windStow === true;

  /**
   * `set_target` and `start_scan` are separate controls: the target must be
   * committed before the scan starts, and the service rejects the start if the
   * target is below 15° elevation, fewer than three dishes are in service, or
   * wind stow is engaged.
   */
  const submitStart = async () => {
    const custom = targetingMode === "custom";
    const raHours = Number(customRaHours);
    const decDeg = Number(customDecDeg);
    if (custom && (!Number.isFinite(raHours) || !Number.isFinite(decDeg))) return;
    if (!custom && !targetId) return;

    const value = custom
      ? {
          ra_rad: ((raHours % 24) + 24) % 24 * (Math.PI / 12),
          dec_rad: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, decDeg * (Math.PI / 180))),
          fov_rad: 0.02,
        }
      : targetId;

    const targeted = await run(
      { service: "RTA", entity: "main", control: "set_target", value, researcher: operator },
      `Set target ${custom ? `RA ${raHours}h / Dec ${decDeg}°` : targetId}`,
    );
    if (!targeted) return;

    await run(
      { service: "RTA", entity: "main", control: "start_scan", value: true, researcher: operator },
      `Start scan ${custom ? "custom position" : targetId}`,
    );
  };

  const issue = (
    control: string,
    entity: string,
    value: unknown,
    label: string,
  ) => run({ service: "RTA", entity, control, value, researcher: operator }, label);

  return (
    <div
      className="accent-scope space-y-4"
      style={{ "--accent": SERVICE_ACCENT.RTA } as React.CSSProperties}
    >
      <ServiceHeader
        index="01"
        service="Radio Telescope Array"
        title="100-dish array control"
        blurb={
          <>
            Dish metrics refresh every 2 minutes; scans stream a 1 Hz sample per dish for the
            composite map. Sub-arrays default to <span className="font-mono text-console-ink">main</span>.
          </>
        }
        accent="#ffc978"
        status={
          <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SCAN_TONE[scanStatus] ?? "neutral"}>
            <StatusDot tone={SCAN_TONE[scanStatus] ?? "neutral"} pulse={scanning} />
            {scanStatus}
          </Badge>
          <Badge tone="info">target {activeTargetLabel}</Badge>
          <Badge tone="neutral">last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt) : "—"}</Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
          </div>
        }
      />

      <ReplayBar service="RTA" />

      <PermissionNote service="RTA" code={operator} />

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
        question="Is the array producing science right now, and is it safe to keep observing?"
        tone={
          scanning
            ? windStow
              ? "warn"
              : summary.operational < RTA_MIN_OPERATIONAL_DISHES || summary.hotDishes > 0
                ? "warn"
                : "ok"
            : scanStatus === "SCHEDULED" || scanStatus === "PAUSED"
              ? "warn"
              : "alert"
        }
        answer={
          scanning
            ? `${summary.operational} of ${summary.registered} dishes are integrating on ${activeTargetLabel} at ${
                arrayState?.status.observationFrequencyHz
                  ? formatNumber(arrayState.status.observationFrequencyHz / 1e6, 0)
                  : "—"
              } MHz.`
            : `Not observing — the array is ${scanStatus.toLowerCase()}${
                windStow ? " because of wind stow" : ""
              }${arrayState?.status.nextScanAt ? `, next scan ${formatTime(arrayState.status.nextScanAt)}` : ""}.`
        }
        evidence={[
          {
            label: "Operational dishes",
            value: `${summary.operational} / ${summary.registered}`,
            percent: summary.registered > 0 ? Math.round((summary.operational / summary.registered) * 100) : 0,
            tone: summary.operational < RTA_MIN_OPERATIONAL_DISHES ? "alert" : "ok",
            hint: `minimum ${RTA_MIN_OPERATIONAL_DISHES} to observe`,
          },
          {
            label: "Scan stream",
            value: `${scanPoints.length} pts · ${scanning ? "1 Hz" : "idle"}`,
            tone: scanning ? "signal" : "neutral",
            hint: "samples captured by this platform",
          },
          {
            label: "Hot dishes",
            value: `${summary.hotDishes} ≥ ${RTA_DISH_TEMP_WARN_C.toFixed(0)} °C`,
            tone: summary.hotDishes > 0 ? "alert" : "ok",
            hint: `max ${formatNumber(summary.maxTemperatureC, 1)} °C`,
          },
          {
            label: "Wind stow",
            value: windStow ? "engaged" : "clear",
            tone: windStow ? "alert" : "ok",
            hint: `stows at ${RTA_WIND_STOW_LIMIT_MS} m/s gust`,
          },
        ]}
        footnote="Read this before touching the controls: a scan on a degraded array still produces an image, it just produces a worse one."
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title="Array summary"
            subtitle={`Metrics sampled ${summary.lastMetricsAt ? timeAgo(summary.lastMetricsAt) : "—"}`}
            actions={
              <Badge tone={summary.operational >= RTA_MIN_OPERATIONAL_DISHES ? "ok" : "alert"}>
                {summary.operational}/{summary.registered} operational
              </Badge>
            }
          >
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <Metric
                label="Operational dishes"
                value={summary.operational}
                unit={`/ ${summary.registered}`}
                hint={`Minimum ${RTA_MIN_OPERATIONAL_DISHES} required`}
                tone={summary.operational >= RTA_MIN_OPERATIONAL_DISHES ? "ok" : "alert"}
              />
              <Metric
                label="Degraded / offline"
                value={`${summary.degraded} / ${summary.offline}`}
                hint={`${summary.disabled} disabled · ${summary.stowed} stowed`}
                tone={summary.offline > 0 ? "warn" : "neutral"}
              />
              <Metric
                label="Mean dish temperature"
                value={formatNumber(summary.averageTemperatureC, 1)}
                unit="°C"
                hint={`Max ${formatNumber(summary.maxTemperatureC, 1)} °C · warn ${RTA_DISH_TEMP_WARN_C.toFixed(
                  1,
                )} °C`}
                tone={
                  summary.maxTemperatureC !== null && summary.maxTemperatureC >= RTA_DISH_TEMP_WARN_C
                    ? "alert"
                    : "neutral"
                }
              />
              <Metric
                label="Array power draw"
                value={formatNumber(summary.totalPowerKW, 2)}
                unit="kW"
                hint="Sum of reporting dishes"
              />
              <Metric
                label="Wind stow"
                value={windStow ? "ENGAGED" : "CLEAR"}
                hint={
                  windStow
                    ? `Releases below ${RTA_WIND_RELEASE_MS} m/s · stows at ${RTA_WIND_STOW_LIMIT_MS} m/s`
                    : `Stows at ${RTA_WIND_STOW_LIMIT_MS} m/s gust`
                }
                tone={windStow ? "alert" : "ok"}
              />
              <Metric
                label="Scan"
                value={scanStatus}
                hint={arrayState?.status.scanId ? `scan ${arrayState.status.scanId}` : "no active scan"}
                tone={scanning ? "ok" : "neutral"}
              />
            </div>

            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-console-muted">
                <span>Array availability</span>
                <span>{Math.round((summary.operational / Math.max(summary.registered, 1)) * 100)}%</span>
              </div>
              <ProgressBar
                value={summary.operational}
                max={Math.max(summary.registered, 1)}
                tone={summary.operational >= RTA_MIN_OPERATIONAL_DISHES ? "ok" : "alert"}
              />
            </div>
          </Panel>

          <DishTrendPanel dishId={trendDishId} topic={trendTopic} warnC={RTA_DISH_TEMP_WARN_C} />

          <Panel
            title="Dish rack"
            subtitle="Click a dish to inspect and control it. Colour reflects live condition and temperature."
            actions={
              <>
                <select
                  className="input w-auto py-1 text-[11px]"
                  value={subArrayFilter}
                  onChange={(event) => setSubArrayFilter(event.target.value)}
                  aria-label="Filter by sub-array"
                >
                  <option value="ALL">All sub-arrays ({dishes.length})</option>
                  {subArrays.map(([name, count]) => (
                    <option key={name} value={name}>
                      {name} ({count})
                    </option>
                  ))}
                </select>
                <Badge tone="ok">operational</Badge>
                <Badge tone="warn">degraded / stowed</Badge>
                <Badge tone="alert">fault</Badge>
              </>
            }
          >
            <DishGrid
              dishes={visibleDishes}
              selectedId={selectedDishId}
              onSelect={(id) => {
                setSelectedDishId(id);
                const dish = dishes.find((entry) => entry.id === id);
                setSubArrayDraft(dish?.subArray ?? "main");
              }}
            />
          </Panel>

          <Panel
            title="Scan image"
            subtitle="N×N pixels from pointing offsets and signal strength, averaged over the scan's overlap samples."
            actions={
              <Badge tone={scanning ? "ok" : "neutral"}>
                {scanPoints.length} pts · {scanning ? "1 Hz" : "idle"}
              </Badge>
            }
          >
            <ScanHeatmap samples={scanPoints} scanning={scanning} context={scanContext} />
            {mode === "replay" && (
              <p className="mt-2 text-[11px] text-console-muted">
                Replay snapshots contain the latest state per topic — the image is built from the live
                1 Hz scan stream.
              </p>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Targeting & scan control" subtitle="Pre-programmed targets come from the ARL API.">
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="operator">
                  Operator
                </label>
                <input
                  id="operator"
                  className="input"
                  value={operator}
                  onChange={(event) => setOperator(event.target.value)}
                  placeholder="Researcher name / ID"
                />
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={`btn flex-1 ${targetingMode === "preset" ? "btn-primary" : ""}`}
                  onClick={() => setTargetingMode("preset")}
                >
                  Preset target
                </button>
                <button
                  type="button"
                  className={`btn flex-1 ${targetingMode === "custom" ? "btn-primary" : ""}`}
                  onClick={() => setTargetingMode("custom")}
                >
                  Custom coordinates
                </button>
              </div>

              {targetingMode === "preset" ? (
                <div>
                  <label className="label" htmlFor="target">
                    Target catalogue
                  </label>
                  <select
                    id="target"
                    className="input"
                    value={targetId}
                    onChange={(event) => setTargetId(event.target.value)}
                    disabled={targetsLoading || (targets?.targets.length ?? 0) === 0}
                  >
                    {(targets?.targets.length ?? 0) === 0 && <option value="">No targets available</option>}
                    {targets?.targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.id} · {target.name}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-console-muted">
                    {targetsLoading ? (
                      <span>Loading from ARL API…</span>
                    ) : targets?.source === "unavailable" ? (
                      <span className="text-console-warn">
                        ARL API unavailable — use custom coordinates. {targets.error}
                      </span>
                    ) : (
                      <span>{targets?.targets.length ?? 0} targets loaded</span>
                    )}
                    <button
                      type="button"
                      className="btn ml-auto px-2 py-0.5 text-[9px]"
                      onClick={async () => {
                        setTargetsLoading(true);
                        const response = await fetchTargets(true);
                        setTargets(response);
                        setTargetsLoading(false);
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label" htmlFor="ra">
                      RA (hours)
                    </label>
                    <input
                      id="ra"
                      className="input"
                      inputMode="decimal"
                      value={customRaHours}
                      onChange={(event) => setCustomRaHours(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="dec">
                      Dec (degrees)
                    </label>
                    <input
                      id="dec"
                      className="input"
                      inputMode="decimal"
                      value={customDecDeg}
                      onChange={(event) => setCustomDecDeg(event.target.value)}
                    />
                  </div>
                  <p className="col-span-2 text-[10px] leading-relaxed text-console-muted">
                    Sent as <span className="font-mono">{"{ra_rad, dec_rad, fov_rad}"}</span> on
                    <span className="font-mono"> set_target</span>. The target must be at least 15°
                    above the horizon before the scan will start.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="btn btn-primary col-span-2"
                  onClick={() => void submitStart()}
                  disabled={
                    pending !== null ||
                    (targetingMode === "preset" && !targetId) ||
                    (targetingMode === "custom" &&
                      (!Number.isFinite(Number(customRaHours)) ||
                        !Number.isFinite(Number(customDecDeg)))) ||
                    windStow
                  }
                >
                  {pending === "set_target" || pending === "start_scan" ? "Starting…" : "Start scan"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void issue("pause_scan", "main", true, "Pause scan")}
                  disabled={pending !== null || !scanning}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void issue("start_scan", "main", true, "Resume scan")}
                  disabled={pending !== null || scanStatus !== "PAUSED" || windStow}
                >
                  Resume
                </button>
                <ConfirmButton
                  className="btn btn-danger"
                  label="Cancel scan"
                  confirmLabel="Cancel the scan"
                  impact="Cancelling stops the current integration and discards the unfinished scan image. The samples already captured stay available in replay."
                  onConfirm={() => void issue("cancel_scan", "main", true, "Cancel scan")}
                  disabled={pending !== null || !["SCANNING", "PAUSED", "SCHEDULED"].includes(scanStatus)}
                />
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="label" htmlFor="frequency">
                      Band (MHz)
                    </label>
                    <input
                      id="frequency"
                      className="input"
                      inputMode="decimal"
                      value={frequencyMhz}
                      onChange={(event) => setFrequencyMhz(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void issue(
                        "set_observation_frequency",
                        "main",
                        Number(frequencyMhz) * 1e6,
                        `Set band ${frequencyMhz} MHz`,
                      )
                    }
                    disabled={
                      pending !== null ||
                      scanning ||
                      !Number.isFinite(Number(frequencyMhz)) ||
                      Number(frequencyMhz) < 500 ||
                      Number(frequencyMhz) > 50000
                    }
                  >
                    Set
                  </button>
                </div>
              </div>

              {/*
                Scheduling exists because observing runs on sidereal time, not
                on the operator's shift: the target has to be queued for when it
                rises. `next_scan` is the service's retained target state.
              */}
              <div className="rounded-md border border-console-edge/60 bg-console-void/40 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-console-muted">
                    Scheduled scan
                  </span>
                  <span className="font-mono text-[10px] text-console-ink">
                    {arrayState?.status.nextScanAt ? formatTime(arrayState.status.nextScanAt) : "none queued"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-end gap-2">
                  <div className="flex-1">
                    <label className="label" htmlFor="schedule-at">
                      Queue for
                    </label>
                    <input
                      id="schedule-at"
                      type="datetime-local"
                      className="input py-1 text-[11px]"
                      value={scheduleAt}
                      onChange={(event) => setScheduleAt(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-[10px]"
                    onClick={() =>
                      void issue(
                        "schedule_scan",
                        "main",
                        new Date(scheduleAt).getTime(),
                        `Schedule scan for ${new Date(scheduleAt).toLocaleString()}`,
                      )
                    }
                    disabled={
                      pending !== null ||
                      !scheduleAt ||
                      !Number.isFinite(new Date(scheduleAt).getTime()) ||
                      new Date(scheduleAt).getTime() <= Date.now()
                    }
                    title="Queues a scan for the chosen time; the service rejects past times"
                  >
                    Queue
                  </button>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-[10px]"
                    onClick={() => void issue("schedule_scan", "main", 0, "Clear scheduled scan")}
                    disabled={pending !== null || !arrayState?.status.nextScanAt}
                    title="Clears the queued scan (value 0)"
                  >
                    Clear
                  </button>
                </div>
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
            </div>
          </Panel>

          <PresetPanel
            service="RTA"
            entity={selectedDishId}
            operator={operator}
            run={run}
            pending={pending}
            title="Observation presets"
          />

          <Panel title="Dish control" subtitle="Per-dish actions are published to the MQTT command topic.">
            {!selectedDish ? (
              <EmptyState message="Select a dish from the rack." hint="Condition, temperature, power and aiming vector are shown here." />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-lg text-console-ink">{selectedDish.id}</p>
                    <p className="text-[11px] text-console-muted">
                      sub-array {selectedDish.subArray} · {titleCase(selectedDish.condition)}
                    </p>
                  </div>
                  <Badge
                    tone={
                      selectedDish.condition === "OPERATIONAL"
                        ? "ok"
                        : selectedDish.condition === "OFFLINE" || selectedDish.condition === "DISABLED"
                          ? "alert"
                          : "warn"
                    }
                  >
                    {selectedDish.metrics ? titleCase(selectedDish.condition) : "no telemetry"}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Metric
                    label="Temperature"
                    value={formatNumber(selectedDish.temperatureC, 1)}
                    unit="°C"
                    hint={`Structure · warn ${RTA_DISH_TEMP_WARN_C.toFixed(1)} °C`}
                    tone={
                      selectedDish.temperatureC !== null &&
                      selectedDish.temperatureC >= RTA_DISH_TEMP_WARN_C
                        ? "alert"
                        : "neutral"
                    }
                  />
                  <Metric
                    label="Power"
                    value={formatNumber(selectedDish.powerW, 0)}
                    unit="W"
                  />
                  <Metric
                    label="Aiming azimuth"
                    value={formatNumber(selectedDish.metrics?.azimuthDeg, 2)}
                    unit="°"
                  />
                  <Metric
                    label="Aiming elevation"
                    value={formatNumber(selectedDish.metrics?.elevationDeg, 2)}
                    unit="°"
                  />
                  <Metric
                    label="System temperature"
                    value={formatNumber(selectedDish.metrics?.systemTemperatureK, 1)}
                    unit="K"
                    hint="Receiver noise temperature"
                  />
                  <Metric
                    label="Fault"
                    value={titleCase(selectedDish.metrics?.faultCode ?? "none")}
                    hint={
                      selectedDish.metrics?.enabled === false
                        ? "out of service (disabled)"
                        : selectedDish.metrics?.stowed
                          ? "stowed"
                          : "in service"
                    }
                  />
                </div>

                <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">
                  updated {selectedDish.updatedAt ? `${formatTime(selectedDish.updatedAt)} · ${timeAgo(selectedDish.updatedAt)}` : "—"}
                  {selectedDish.metrics?.lastCalibrationAt
                    ? ` · calibrated ${timeAgo(selectedDish.metrics.lastCalibrationAt)}`
                    : ""}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <ConfirmButton
                    className="btn btn-danger"
                    label="Disable dish"
                    confirmLabel="Take it out of service"
                    impact={`${selectedDish.id} leaves the array immediately and is dropped from any running scan. The array needs at least ${RTA_MIN_OPERATIONAL_DISHES} operational dishes to keep observing.`}
                    onConfirm={() =>
                      void issue("enable_dish", selectedDish.id, false, `Disable ${selectedDish.id}`)
                    }
                    disabled={pending !== null || selectedDish.metrics?.enabled === false}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void issue("enable_dish", selectedDish.id, true, `Enable ${selectedDish.id}`)
                    }
                    disabled={pending !== null || selectedDish.metrics?.enabled === true}
                  >
                    Enable dish
                  </button>
                  <ConfirmButton
                    className="btn col-span-2"
                    label={selectedDish.metrics?.stowed ? "Release dish" : "Stow dish"}
                    confirmLabel={selectedDish.metrics?.stowed ? "Release it" : "Stow it"}
                    impact={
                      selectedDish.metrics?.stowed
                        ? `${selectedDish.id} returns to observing; it will slew back to the array's current pointing.`
                        : `${selectedDish.id} points straight up and holds there, taking it out of the array until released.`
                    }
                    onConfirm={() =>
                      void issue(
                        "stow_dish",
                        selectedDish.id,
                        selectedDish.metrics?.stowed !== true,
                        `${selectedDish.metrics?.stowed ? "Release" : "Stow"} ${selectedDish.id}`,
                      )
                    }
                    disabled={pending !== null || windStow}
                  />
                  <button
                    type="button"
                    className="btn col-span-2"
                    onClick={() =>
                      void issue(
                        "request_recalibration",
                        selectedDish.id,
                        true,
                        `Recalibrate ${selectedDish.id}`,
                      )
                    }
                    disabled={pending !== null}
                  >
                    Request recalibration (120 s)
                  </button>
                </div>

                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="label" htmlFor="subarray">
                      Reassign sub-array
                    </label>
                    <input
                      id="subarray"
                      className="input"
                      value={subArrayDraft}
                      onChange={(event) => setSubArrayDraft(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void issue(
                        "assign_subarray",
                        selectedDish.id,
                        subArrayDraft.trim() || "main",
                        `Assign ${selectedDish.id} → ${subArrayDraft.trim() || "main"}`,
                      )
                    }
                    disabled={pending !== null || subArrayDraft.trim().length === 0}
                  >
                    Assign
                  </button>
                </div>

                {/*
                  Manual slewing is the fallback when the target catalogue is
                  unavailable: the service accepts azimuth/elevation in radians
                  and rejects the move while the dish is scanning or stowed.
                */}
                <div className="rounded-md border border-console-edge/60 bg-console-void/40 px-2.5 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-console-muted">
                      Manual pointing
                    </span>
                    <span className="font-mono text-[10px] text-console-muted">
                      now {formatNumber(selectedDish.metrics?.azimuthDeg, 1)}° /{" "}
                      {formatNumber(selectedDish.metrics?.elevationDeg, 1)}°
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <div>
                      <label className="label" htmlFor="point-az">
                        Azimuth (°)
                      </label>
                      <input
                        id="point-az"
                        className="input py-1 text-[11px]"
                        inputMode="decimal"
                        value={azimuthDraft}
                        onChange={(event) => setAzimuthDraft(event.target.value)}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="point-el">
                        Elevation (°)
                      </label>
                      <input
                        id="point-el"
                        className="input py-1 text-[11px]"
                        inputMode="decimal"
                        value={elevationDraft}
                        onChange={(event) => setElevationDraft(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <ConfirmButton
                      className="btn px-2 py-1 text-[10px]"
                      label="Slew azimuth"
                      confirmLabel="Slew it"
                      impact={`${selectedDish.id} slews to ${azimuthDraft || "—"}° azimuth in one move; the dish cannot track a target while it is slewing, so any running scan loses that dish's samples until it settles.`}
                      onConfirm={() =>
                        void issue(
                          "adjust_azimuth",
                          selectedDish.id,
                          (Number(azimuthDraft) * Math.PI) / 180,
                          `Slew ${selectedDish.id} to azimuth ${azimuthDraft}°`,
                        )
                      }
                      disabled={
                        pending !== null ||
                        scanning ||
                        selectedDish.metrics?.stowed === true ||
                        !Number.isFinite(Number(azimuthDraft)) ||
                        Number(azimuthDraft) < 0 ||
                        Number(azimuthDraft) > 360
                      }
                    />
                    <ConfirmButton
                      className="btn px-2 py-1 text-[10px]"
                      label="Slew elevation"
                      confirmLabel="Slew it"
                      impact={`${selectedDish.id} slews to ${elevationDraft || "—"}° elevation. Below 15° the array cannot observe there, and the service refuses anything under 5°.`}
                      onConfirm={() =>
                        void issue(
                          "adjust_elevation",
                          selectedDish.id,
                          (Number(elevationDraft) * Math.PI) / 180,
                          `Slew ${selectedDish.id} to elevation ${elevationDraft}°`,
                        )
                      }
                      disabled={
                        pending !== null ||
                        scanning ||
                        selectedDish.metrics?.stowed === true ||
                        !Number.isFinite(Number(elevationDraft)) ||
                        Number(elevationDraft) < 5 ||
                        Number(elevationDraft) > 90
                      }
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-console-muted">
                    Sent in radians; rejected while scanning or stowed, and under 5° elevation.
                  </p>
                </div>
              </div>
            )}
          </Panel>

          <AlertAnnunciator title="Annunciator · RTA alerts" maxHeight="max-h-[380px]" />
        </div>
      </div>
    </div>
  );
}
