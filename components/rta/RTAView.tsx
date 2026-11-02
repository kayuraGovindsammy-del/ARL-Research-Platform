"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchTargets, type TargetsResponse } from "@/lib/api-client";
import { formatNumber, formatTime, timeAgo, titleCase } from "@/lib/format";
import {
  deriveRtaAlerts,
  getArrayStatus,
  getDishes,
  getScanSamples,
  summarizeDishes,
} from "@/lib/rta-selectors";
import { useTelemetry } from "@/lib/telemetry-store";
import {
  RTA_DISH_TEMP_LIMIT_C,
  RTA_MIN_OPERATIONAL_DISHES,
  RTA_WIND_STOW_LIMIT_MS,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
import { ReplayBar } from "../ReplayBar";
import { Badge, EmptyState, Metric, Panel, ProgressBar, StatusDot } from "../ui";
import { DishGrid } from "./DishGrid";
import { ScanHeatmap } from "./ScanHeatmap";

const SCAN_TONE: Record<string, "ok" | "warn" | "alert" | "info" | "neutral"> = {
  SCANNING: "ok",
  PAUSED: "warn",
  IDLE: "info",
  STOWED: "alert",
  CANCELLED: "alert",
};

export function RTAView() {
  const { topics, stream, lastTelemetryAt, mode } = useTelemetry();
  const { operator, setOperator } = useOperator();
  const { run, pending, feedback } = useCommandRunner();

  const [subArrayFilter, setSubArrayFilter] = useState("ALL");
  const [selectedDishId, setSelectedDishId] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetsResponse | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetingMode, setTargetingMode] = useState<"preset" | "custom">("preset");
  const [targetId, setTargetId] = useState("");
  const [customRa, setCustomRa] = useState("05.575");
  const [customDec, setCustomDec] = useState("-05.391");
  const [subArrayDraft, setSubArrayDraft] = useState("main");

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

  const scanPoints = useMemo(() => getScanSamples(stream), [stream]);
  const scanStatus = (arrayState?.status.status ?? "IDLE").toUpperCase();
  const scanning = scanStatus === "SCANNING";
  const derivedAlerts = useMemo(
    () => deriveRtaAlerts(summary, arrayState?.status ?? null),
    [summary, arrayState],
  );

  const activeTargetLabel =
    arrayState?.status.targetName ?? arrayState?.status.targetId ?? "none";
  const wind = arrayState?.status.windSpeedMs;

  const submitStart = async () => {
    if (targetingMode === "preset" && !targetId) return;
    const custom = targetingMode === "custom";
    const ra = custom ? Number(customRa) : null;
    const dec = custom ? Number(customDec) : null;
    if (custom && (!Number.isFinite(ra) || !Number.isFinite(dec))) return;

    await run(
      {
        service: "RTA",
        action: "scan.start",
        targetId: custom ? `custom:${customRa}:${customDec}` : targetId,
        custom,
        ra: ra ?? undefined,
        dec: dec ?? undefined,
        issuedBy: operator,
      },
      custom ? `Start custom scan RA ${customRa} / Dec ${customDec}` : `Start scan ${targetId}`,
    );
  };

  const issue = (action: string, payload: Record<string, unknown>, label: string) =>
    run({ service: "RTA", action, issuedBy: operator, ...payload }, label);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-console-signal">
            Service 01 · Radio Telescope Array
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-console-ink">
            100-dish array control
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-console-muted">
            Dish metrics refresh every 2 minutes; scans stream a 1 Hz sample per dish for the
            composite map. Sub-arrays default to <span className="font-mono text-console-ink">main</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SCAN_TONE[scanStatus] ?? "neutral"}>
            <StatusDot tone={SCAN_TONE[scanStatus] ?? "neutral"} pulse={scanning} />
            {scanStatus}
          </Badge>
          <Badge tone="info">target {activeTargetLabel}</Badge>
          <Badge tone="neutral">last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt) : "—"}</Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
        </div>
      </header>

      <ReplayBar service="RTA" />

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
                hint={`Max ${formatNumber(summary.maxTemperatureC, 1)} °C · limit ${RTA_DISH_TEMP_LIMIT_C} °C`}
                tone={
                  summary.maxTemperatureC !== null && summary.maxTemperatureC >= RTA_DISH_TEMP_LIMIT_C
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
                label="Wind speed"
                value={wind !== undefined ? formatNumber(wind, 1) : "—"}
                unit="m/s"
                hint={`Stow threshold ${RTA_WIND_STOW_LIMIT_MS} m/s`}
                tone={typeof wind === "number" && wind >= RTA_WIND_STOW_LIMIT_MS ? "alert" : "neutral"}
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
            title="Scan composite"
            subtitle="High-frequency scan samples rendered as a dish-offset × frequency heatmap."
            actions={
              <Badge tone={scanning ? "ok" : "neutral"}>
                {scanPoints.length} pts · {scanning ? "1 Hz" : "idle"}
              </Badge>
            }
          >
            <ScanHeatmap
              samples={scanPoints}
              scanning={scanning}
              activeScanId={arrayState?.status.scanId ?? null}
            />
            {mode === "replay" && (
              <p className="mt-2 text-[11px] text-console-muted">
                Replay snapshots contain the latest state per topic — start a live scan to rebuild the
                composite map.
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
                      value={customRa}
                      onChange={(event) => setCustomRa(event.target.value)}
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
                      value={customDec}
                      onChange={(event) => setCustomDec(event.target.value)}
                    />
                  </div>
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
                      (!Number.isFinite(Number(customRa)) || !Number.isFinite(Number(customDec))))
                  }
                >
                  {pending === "scan.start" ? "Starting…" : "Start scan"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void issue("scan.pause", {}, "Pause scan")}
                  disabled={pending !== null || !scanning}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void issue("scan.resume", {}, "Resume scan")}
                  disabled={pending !== null || scanStatus !== "PAUSED"}
                >
                  Resume
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void issue("scan.cancel", {}, "Cancel scan")}
                  disabled={pending !== null || !["SCANNING", "PAUSED"].includes(scanStatus)}
                >
                  Cancel scan
                </button>
                <button
                  type="button"
                  className="btn btn-warn"
                  onClick={() => void issue("array.stow", {}, "Stow array")}
                  disabled={pending !== null}
                >
                  Stow array
                </button>
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
                    tone={
                      selectedDish.temperatureC !== null &&
                      selectedDish.temperatureC >= RTA_DISH_TEMP_LIMIT_C
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
                </div>

                <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">
                  updated {selectedDish.updatedAt ? `${formatTime(selectedDish.updatedAt)} · ${timeAgo(selectedDish.updatedAt)}` : "—"}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() =>
                      void issue(
                        "dish.disable",
                        { dishId: selectedDish.id },
                        `Disable ${selectedDish.id}`,
                      )
                    }
                    disabled={pending !== null}
                  >
                    Disable dish
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void issue(
                        "dish.enable",
                        { dishId: selectedDish.id },
                        `Enable ${selectedDish.id}`,
                      )
                    }
                    disabled={pending !== null}
                  >
                    Enable dish
                  </button>
                  <button
                    type="button"
                    className="btn col-span-2"
                    onClick={() =>
                      void issue("dish.stow", { dishId: selectedDish.id }, `Stow ${selectedDish.id}`)
                    }
                    disabled={pending !== null}
                  >
                    Stow dish
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
                        "array.subArray",
                        { dishId: selectedDish.id, subArray: subArrayDraft.trim() || "main" },
                        `Assign ${selectedDish.id} → ${subArrayDraft.trim() || "main"}`,
                      )
                    }
                    disabled={pending !== null || subArrayDraft.trim().length === 0}
                  >
                    Assign
                  </button>
                </div>
              </div>
            )}
          </Panel>

          <AlertAnnunciator title="RTA alerts" maxHeight="max-h-[380px]" />
        </div>
      </div>
    </div>
  );
}
