"use client";

import { useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  deriveWeatherAlerts,
  getLightning,
  getWeatherSites,
  summarizeWeather,
} from "@/lib/lwm-selectors";
import { formatNumber, formatTime, timeAgo, titleCase } from "@/lib/format";
import { useTelemetry, type ServiceEvent } from "@/lib/telemetry-store";
import {
  LWM_SOILING_WARN_RATIO,
  RTA_WIND_STOW_LIMIT_MS,
  type TopicState,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useNow } from "@/lib/use-now";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
import { ConfirmButton } from "../ConfirmButton";
import { PermissionNote } from "../PermissionNote";
import { PresetPanel } from "../PresetPanel";
import { ReplayBar } from "../ReplayBar";
import { Badge, EmptyState, Metric, Panel, ProgressBar, StatusDot } from "../ui";

const CHART_GRID = "#1c2533";
const CHART_TICK = "#7d8ca3";

/** Site that carries each specialist instrument, read from the LWM topology. */
const SONIC_SITE = "lwm-3";
const SOILING_SITE = "lwm-4";
const PAN_SITE = "lwm-5";

function gustTone(gust: number | null): "ok" | "warn" | "alert" | "neutral" {
  if (gust === null) return "neutral";
  if (gust >= RTA_WIND_STOW_LIMIT_MS) return "alert";
  if (gust >= RTA_WIND_STOW_LIMIT_MS * 0.8) return "warn";
  return "ok";
}

function gustColor(gust: number | null): string {
  if (gust === null) return "#2a3546";
  if (gust >= RTA_WIND_STOW_LIMIT_MS) return "#ff5d5d";
  if (gust >= RTA_WIND_STOW_LIMIT_MS * 0.8) return "#ffab4a";
  return "#38f2c3";
}

function compassLabel(degrees: number | null): string {
  if (degrees === null) return "—";
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return `${points[Math.round(degrees / 22.5) % 16]} ${Math.round(degrees)}°`;
}

/**
 * Local Weather Monitoring console.
 *
 * LWM is the context service: five stations on fixed positions, each reporting
 * once a minute, three of them carrying a specialist instrument. None of those
 * numbers matter on their own — what matters is what they do to the other two
 * services, so the page is built around that: gusts against the array's stow
 * limit, irradiance and soiling against the solar yield, evaporation against
 * the hydroponics water budget. The station list is the evidence behind those
 * panels, not the point of the page.
 */
export function LWMView() {
  const { topics, events, mode, lastTelemetryAt } = useTelemetry();
  const { operator, setOperator } = useOperator();
  const { run, pending, feedback } = useCommandRunner();
  const now = useNow(30_000);

  const sites = useMemo(() => getWeatherSites(topics), [topics]);
  const summary = useMemo(() => summarizeWeather(sites, now), [sites, now]);
  const lightning = useMemo(() => getLightning(topics), [topics]);
  const derivedAlerts = useMemo(() => deriveWeatherAlerts(sites, summary, now), [sites, summary, now]);

  const [selectedSiteId, setSelectedSiteId] = useState(SONIC_SITE);
  const [intervalDraft, setIntervalDraft] = useState("60");
  const seededSite = useRef<string | null>(null);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? sites[0] ?? null,
    [sites, selectedSiteId],
  );

  // Seed the interval box once per station so a live update cannot overwrite
  // what the operator is typing; the panel shows the published value anyway.
  if (selectedSite && seededSite.current !== selectedSite.id) {
    seededSite.current = selectedSite.id;
    if (typeof selectedSite.sampleIntervalS === "number") {
      setIntervalDraft(String(selectedSite.sampleIntervalS));
    }
  }

  const issue = (control: string, entity: string, value: unknown, label: string) =>
    run({ service: "LWM", entity, control, value, researcher: operator }, label);

  const lightningEvents = useMemo(
    () =>
      events
        .filter((event: ServiceEvent) => event.kind.includes("lightning"))
        .slice(-6)
        .reverse(),
    [events],
  );

  const stowRisk = summary.stowMarginMs !== null && summary.stowMarginMs <= 0;
  const chartData = sites
    .filter((site) => site.weather !== null)
    .map((site) => ({
      site: site.id,
      gust: site.weather?.windGustMs ?? 0,
      wind: site.weather?.windSpeedMs ?? 0,
    }));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-console-signal">
            Service 04 · Local Weather Monitoring
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-console-ink">
            Site weather & instrument health
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-console-muted">
            Five stations on fixed positions, once a minute. The gust figure is what stows the
            array; the irradiance and soiling figures explain the solar plant's yield.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stowRisk ? "alert" : "ok"}>
            <StatusDot tone={stowRisk ? "alert" : "ok"} pulse={stowRisk} />
            {stowRisk ? "stow-level gust" : "below stow limit"}
          </Badge>
          <Badge tone="neutral">
            {summary.sitesReporting}/{summary.totalSites} sites
          </Badge>
          <Badge tone={summary.staleSites > 0 ? "warn" : "neutral"}>
            {summary.staleSites} stale
          </Badge>
          <Badge tone="neutral">
            last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt, now) : "—"}
          </Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
        </div>
      </header>

      <ReplayBar service="LWM" />

      <PermissionNote service="LWM" code={operator} />

      {derivedAlerts.length > 0 && (
        <div className="panel border-console-warn/40 bg-console-warn/5 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {derivedAlerts.slice(0, 6).map((alert) => (
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
            {derivedAlerts.length > 6 && (
              <span className="text-xs text-console-muted">+{derivedAlerts.length - 6} more</span>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        <Metric
          label="Peak gust"
          value={formatNumber(summary.maxGustMs, 1)}
          unit="m/s"
          hint={summary.maxGustSite ? `at ${summary.maxGustSite}` : "no gusts"}
          tone={gustTone(summary.maxGustMs)}
        />
        <Metric
          label="Stow margin"
          value={summary.stowMarginMs === null ? "—" : formatNumber(summary.stowMarginMs, 1)}
          unit="m/s"
          hint={`stow at ${RTA_WIND_STOW_LIMIT_MS} m/s`}
          tone={stowRisk ? "alert" : "ok"}
        />
        <Metric
          label="Mean wind"
          value={formatNumber(summary.meanWindMs, 1)}
          unit="m/s"
          hint={`gust factor ${summary.gustFactor === null ? "—" : formatNumber(summary.gustFactor, 2)}`}
        />
        <Metric
          label="Irradiance"
          value={summary.meanIrradianceWm2 === null ? "—" : formatNumber(summary.meanIrradianceWm2, 0)}
          unit="W/m²"
          hint={`peak ${summary.maxIrradianceWm2 === null ? "—" : formatNumber(summary.maxIrradianceWm2, 0)}`}
          tone="signal"
        />
        <Metric
          label="Soiling ratio"
          value={formatNumber(summary.minSoilingRatio, 3)}
          hint={summary.soilingSite ? `cleanest reference: ${summary.soilingSite}` : "not reported"}
          tone={
            summary.minSoilingRatio !== null && summary.minSoilingRatio < LWM_SOILING_WARN_RATIO
              ? "warn"
              : "ok"
          }
        />
        <Metric
          label="Temperature"
          value={formatNumber(summary.meanTemperatureC, 1)}
          unit="°C"
          hint={`RH ${summary.meanHumidityPct === null ? "—" : formatNumber(summary.meanHumidityPct, 0)} % · ${summary.meanPressureHpa === null ? "—" : formatNumber(summary.meanPressureHpa, 0)} hPa`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title="Gust against the array's stow limit"
            subtitle={`Every station's latest gust, against the ${RTA_WIND_STOW_LIMIT_MS} m/s limit that puts the dishes into wind stow.`}
            actions={
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                <span className="text-console-signal">nominal</span>
                <span className="text-console-warn">within 20 %</span>
                <span className="text-console-alert">at limit</span>
              </div>
            }
          >
            <div className="h-56 w-full">
              {chartData.length === 0 ? (
                <EmptyState
                  message="No weather samples yet."
                  hint="Each station publishes once a minute on arl/lwm/<site>/telemetry/weather."
                />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, bottom: 0, left: -8 }}
                    barCategoryGap={8}
                  >
                    <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[0, Math.max(RTA_WIND_STOW_LIMIT_MS * 1.2, (summary.maxGustMs ?? 0) * 1.1)]}
                      stroke={CHART_TICK}
                      tick={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                      unit=" m/s"
                    />
                    <YAxis
                      type="category"
                      dataKey="site"
                      width={62}
                      stroke={CHART_TICK}
                      tick={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                    />
                    <Tooltip
                      cursor={{ fill: "#101823" }}
                      contentStyle={{
                        background: "#0b1018",
                        border: "1px solid #1c2533",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                    />
                    <ReferenceLine
                      x={RTA_WIND_STOW_LIMIT_MS}
                      stroke="#ff5d5d"
                      strokeDasharray="4 4"
                      label={{ value: "stow", fill: "#ff5d5d", fontSize: 10, position: "insideTopRight" }}
                    />
                    <Bar dataKey="gust" name="Gust m/s" radius={[0, 3, 3, 0]}>
                      {chartData.map((entry) => (
                        <Cell key={entry.site} fill={gustColor(entry.gust)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-console-muted">
              The array stows when any station reports a gust at or above the limit and releases below{" "}
              {RTA_WIND_STOW_LIMIT_MS - 5} m/s. A gust that never reaches a station — a local
              downburst at the dishes — is the failure this instrument layout cannot see.
            </p>
          </Panel>

          <Panel
            title="Stations"
            subtitle="Latest sample per site, with the specialist instrument that station carries."
            actions={<Badge tone="neutral">{sites.length} sites</Badge>}
          >
            {sites.length === 0 ? (
              <EmptyState message="No stations reporting." hint="Check the LWM service is publishing." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-console-edge/70 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                      <th className="py-1.5 pr-2 font-medium">Site</th>
                      <th className="py-1.5 pr-2 font-medium">Temp</th>
                      <th className="py-1.5 pr-2 font-medium">RH</th>
                      <th className="py-1.5 pr-2 font-medium">Wind</th>
                      <th className="py-1.5 pr-2 font-medium">Gust</th>
                      <th className="py-1.5 pr-2 font-medium">From</th>
                      <th className="py-1.5 pr-2 font-medium">Irradiance</th>
                      <th className="py-1.5 pr-2 font-medium">Battery</th>
                      <th className="py-1.5 pr-2 font-medium">Instrument</th>
                      <th className="py-1.5 pr-2 font-medium">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map((site) => {
                      const weather = site.weather;
                      const instrument =
                        site.id === SONIC_SITE && site.sonic
                          ? `sonic · TI ${formatNumber(site.sonic.turbulence_intensity, 2)}`
                          : site.id === SOILING_SITE && site.soiling
                            ? `soiling · ${formatNumber(site.soiling.soiling_ratio, 3)}`
                            : site.id === PAN_SITE && site.pan
                              ? `pan · ${formatNumber(site.pan.pan_level_mm, 1)} mm`
                              : "weather only";
                      return (
                        <tr
                          key={site.id}
                          className={`border-b border-console-edge/40 last:border-b-0 ${
                            site.id === selectedSite?.id ? "bg-console-grid/40" : ""
                          }`}
                        >
                          <td className="py-1.5 pr-2">
                            <button
                              type="button"
                              className="font-mono uppercase tracking-[0.1em] text-console-info hover:text-console-signal"
                              onClick={() => setSelectedSiteId(site.id)}
                            >
                              {site.id}
                            </button>
                            {site.enabled === false && (
                              <span className="ml-1 text-[10px] text-console-warn">disabled</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 font-mono">{formatNumber(weather?.temperatureC, 1)} °C</td>
                          <td className="py-1.5 pr-2 font-mono">{formatNumber(weather?.humidityPct, 0)} %</td>
                          <td className="py-1.5 pr-2 font-mono">{formatNumber(weather?.windSpeedMs, 1)}</td>
                          <td
                            className={`py-1.5 pr-2 font-mono ${
                              gustTone(weather?.windGustMs ?? null) === "alert"
                                ? "text-console-alert"
                                : gustTone(weather?.windGustMs ?? null) === "warn"
                                  ? "text-console-warn"
                                  : ""
                            }`}
                          >
                            {formatNumber(weather?.windGustMs, 1)}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-console-muted">
                            {compassLabel(weather?.windDirectionDeg ?? null)}
                          </td>
                          <td className="py-1.5 pr-2 font-mono">{formatNumber(weather?.irradianceWm2, 0)}</td>
                          <td className="py-1.5 pr-2 font-mono">{formatNumber(weather?.batteryV, 2)} V</td>
                          <td className="py-1.5 pr-2 text-console-muted">{instrument}</td>
                          <td className="py-1.5 pr-2 font-mono text-console-muted">
                            {site.timestamp ? timeAgo(site.timestamp, now) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="What the weather means for the other services"
            subtitle="The same readings, read as consequences rather than measurements."
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">Array (RTA)</p>
                <p className="mt-1 text-sm text-console-ink">
                  {stowRisk
                    ? `Stows now — ${formatNumber(summary.maxGustMs, 1)} m/s at ${summary.maxGustSite}.`
                    : summary.maxGustMs === null
                      ? "No wind context."
                      : `${formatNumber(summary.stowMarginMs, 1)} m/s below the stow limit.`}
                </p>
                <div className="mt-2">
                  <ProgressBar
                    value={summary.maxGustMs ?? 0}
                    max={RTA_WIND_STOW_LIMIT_MS}
                    tone={gustTone(summary.maxGustMs)}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">Solar (OPG)</p>
                <p className="mt-1 text-sm text-console-ink">
                  {summary.meanIrradianceWm2 === null
                    ? "No irradiance reported."
                    : `${formatNumber(summary.meanIrradianceWm2, 0)} W/m² reaching the panels`}
                </p>
                <p className="mt-1 text-[11px] text-console-muted">
                  {summary.minSoilingRatio === null
                    ? "soiling unknown"
                    : summary.minSoilingRatio < LWM_SOILING_WARN_RATIO
                      ? `soiling ${formatNumber(summary.minSoilingRatio, 3)} — yield is being lost to dust, clean the reference cell`
                      : `soiling ${formatNumber(summary.minSoilingRatio, 3)} — panels are clean`}
                </p>
              </div>
              <div className="rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">Water (MHE)</p>
                <p className="mt-1 text-sm text-console-ink">
                  {summary.evaporationMm === null
                    ? "No pan data."
                    : `${formatNumber(summary.evaporationMm, 2)} mm evaporated`}
                </p>
                <p className="mt-1 text-[11px] text-console-muted">
                  pan level {summary.panLevelMm === null ? "—" : `${formatNumber(summary.panLevelMm, 1)} mm`} ·
                  rain {summary.totalRainfallMm === null ? "—" : `${formatNumber(summary.totalRainfallMm, 2)} mm`}
                </p>
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel
            title="Station control"
            subtitle={
              selectedSite ? `Selected: ${selectedSite.id}` : "Select a station from the table"
            }
          >
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="lwm-operator">
                  Operator
                </label>
                <input
                  id="lwm-operator"
                  className="input"
                  value={operator}
                  onChange={(event) => setOperator(event.target.value)}
                  placeholder="Researcher name / ID"
                />
              </div>

              <div>
                <span className="label">Current state → target</span>
                <div className="grid grid-cols-2 gap-1 font-mono text-[10px] text-console-muted">
                  <span>
                    enabled{" "}
                    <span className="text-console-ink">
                      {selectedSite?.enabled === null ? "unknown" : selectedSite?.enabled ? "yes" : "no"}
                    </span>
                  </span>
                  <span>
                    interval{" "}
                    <span className="text-console-ink">
                      {selectedSite?.sampleIntervalS === null
                        ? "—"
                        : `${selectedSite?.sampleIntervalS}s`}
                    </span>
                  </span>
                  <span>
                    calib{" "}
                    <span className="text-console-ink">
                      {selectedSite?.lastCalibrationAt
                        ? timeAgo(new Date(selectedSite.lastCalibrationAt).toISOString(), now)
                        : "—"}
                    </span>
                  </span>
                  <span>
                    pos{" "}
                    <span className="text-console-ink">
                      {selectedSite?.position
                        ? `${selectedSite.position.lat.toFixed(3)}, ${selectedSite.position.lon.toFixed(3)}`
                        : "—"}
                    </span>
                  </span>
                </div>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="lwm-interval">
                    Sample interval (s)
                  </label>
                  <input
                    id="lwm-interval"
                    className="input"
                    inputMode="numeric"
                    value={intervalDraft}
                    onChange={(event) => setIntervalDraft(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    pending !== null ||
                    !selectedSite ||
                    !Number.isFinite(Number(intervalDraft)) ||
                    Number(intervalDraft) < 10 ||
                    Number(intervalDraft) > 3600
                  }
                  onClick={() =>
                    selectedSite &&
                    void issue(
                      "sample_interval",
                      selectedSite.id,
                      Number(intervalDraft),
                      `Sample ${selectedSite.id} every ${intervalDraft}s`,
                    )
                  }
                >
                  Apply
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="btn"
                  disabled={pending !== null || !selectedSite || selectedSite.enabled === true}
                  onClick={() =>
                    selectedSite &&
                    void issue("enable_site", selectedSite.id, true, `Enable ${selectedSite.id}`)
                  }
                >
                  Enable site
                </button>
                <ConfirmButton
                  label="Disable site"
                  impact={`${
                    selectedSite?.id ?? "This station"
                  } leaves the reporting set: its gust is no longer part of the wind-stow decision, and its temperature, irradiance and battery history stop growing. Disable it for servicing only.`}
                  confirmLabel="Disable the station"
                  disabled={pending !== null || !selectedSite || selectedSite.enabled === false}
                  className="btn btn-warn"
                  onConfirm={() =>
                    selectedSite &&
                    void issue("enable_site", selectedSite.id, false, `Disable ${selectedSite.id}`)
                  }
                />
                <ConfirmButton
                  label="Recalibrate"
                  impact={`${
                    selectedSite?.id ?? "This station"
                  } recalibrates its sensors against their references. Readings taken during the calibration are marked, so a trend that spans it will show a step.`}
                  confirmLabel="Recalibrate"
                  disabled={pending !== null || !selectedSite}
                  className="btn"
                  onConfirm={() =>
                    selectedSite &&
                    void issue(
                      "request_recalibration",
                      selectedSite.id,
                      true,
                      `Recalibrate ${selectedSite.id}`,
                    )
                  }
                />
                <ConfirmButton
                  label="Service anemometer"
                  impact={`The wind sensor on ${
                    selectedSite?.id ?? "this station"
                  } is serviced: it publishes no wind or gust for the duration, which removes that station from the array's stow decision until it returns.`}
                  confirmLabel="Service it"
                  disabled={pending !== null || !selectedSite}
                  className="btn"
                  onConfirm={() =>
                    selectedSite &&
                    void issue(
                      "service_anemometer",
                      selectedSite.id,
                      true,
                      `Service anemometer on ${selectedSite.id}`,
                    )
                  }
                />
                {selectedSite?.id === SOILING_SITE && (
                  <ConfirmButton
                    label="Clean reference cell"
                    impact="Cleaning restores the soiling ratio towards 1.0. Until it settles, the solar yield comparison against the reference is meaningless."
                    confirmLabel="Clean it"
                    disabled={pending !== null}
                    className="btn col-span-2"
                    onConfirm={() =>
                      void issue("clean_reference_cell", SOILING_SITE, true, "Clean the reference cell")
                    }
                  />
                )}
                {selectedSite?.id === PAN_SITE && (
                  <ConfirmButton
                    label="Refill pan"
                    impact="Refilling resets the evaporation pan to its working level. Evaporation measured across a refill is not comparable, so note the refill in the log."
                    confirmLabel="Refill it"
                    disabled={pending !== null}
                    className="btn col-span-2"
                    onConfirm={() => void issue("refill_pan", PAN_SITE, true, "Refill the evaporation pan")}
                  />
                )}
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
            service="LWM"
            entity={selectedSite?.id ?? null}
            operator={operator}
            run={run}
            pending={pending}
            title="Instrument presets"
          />

          <Panel
            title="Lightning"
            subtitle="Strike counter for the whole site, with the events the service published."
            actions={
              <Badge tone={(lightning?.strikes_last_min ?? 0) > 0 ? "alert" : "ok"}>
                {(lightning?.strikes_last_min ?? 0) > 0 ? "strikes" : "clear"}
              </Badge>
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label="Strikes / min"
                value={lightning?.strikes_last_min ?? "—"}
                tone={(lightning?.strikes_last_min ?? 0) > 0 ? "alert" : "ok"}
              />
              <Metric
                label="Nearest strike"
                value={
                  lightning?.nearest_strike_km === null || lightning?.nearest_strike_km === undefined
                    ? "—"
                    : formatNumber(lightning.nearest_strike_km, 1)
                }
                unit="km"
              />
            </div>
            {lightningEvents.length === 0 ? (
              <p className="mt-2 text-[11px] text-console-muted">No lightning events published yet.</p>
            ) : (
              <ul className="mt-2 space-y-0.5">
                {lightningEvents.map((event, index) => (
                  <li
                    key={`${event.timestamp}-${index}`}
                    className="flex items-center gap-2 text-[11px] text-console-muted"
                  >
                    <span className="font-mono">{formatTime(event.timestamp)}</span>
                    <span className="text-console-ink">{titleCase(event.kind)}</span>
                    <span className="truncate">
                      {event.payload.nearest_strike_km !== undefined
                        ? `${event.payload.nearest_strike_km} km`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <AlertAnnunciator title="LWM alerts" maxHeight="max-h-[380px]" />
        </div>
      </div>
    </div>
  );
}
