"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "@/lib/api-client";
import { formatNumber, timeAgo } from "@/lib/format";
import { getCrew, getRooms, summarizeRooms } from "@/lib/mhe-selectors";
import { computeTotals, getPower } from "@/lib/opg-selectors";
import { getArrayStatus, getDishes, summarizeDishes } from "@/lib/rta-selectors";
import { useTelemetry } from "@/lib/telemetry-store";
import {
  MHE_CO2_LIMIT_PPM,
  MHE_ROOMS,
  OPG_BATTERY_CRITICAL_PCT,
  OPG_DIESEL_LOW_FUEL_PCT,
  RTA_MIN_OPERATIONAL_DISHES,
  RTA_WIND_RELEASE_MS,
  RTA_WIND_STOW_LIMIT_MS,
} from "@/lib/types";
import { useNow } from "@/lib/use-now";
import { AlertAnnunciator } from "./AlertAnnunciator";
import { LabMap } from "./LabMap";
import { ReplayBar } from "./ReplayBar";
import { Badge, Metric, Panel, ProgressBar, StatusDot } from "./ui";

interface HealthResponse {
  ok: boolean;
  time: string;
  env: { ok: boolean; error?: string };
  database: { ok: boolean; detail: string; latestSampleAt?: string | null };
  mqtt: {
    state: string;
    connected: boolean;
    messagesIngested: number;
    alertsRaised: number;
    lastMessageAt: string | null;
    lastError: string | null;
  };
  arlApi: { docsUrl: string | null };
}

function ratio(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((value / total) * 100)}%`;
}

function OpenLink({ href }: { href: string }) {
  return (
    <Link href={href} className="btn btn-primary px-2.5 py-1 text-[10px]">
      Open console
    </Link>
  );
}

export function OverviewView() {
  const { topics, mode, connection, counts, lastTelemetryAt, error } = useTelemetry();
  const now = useNow(15_000);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getJson<HealthResponse>("/api/health");
        if (!cancelled) {
          setHealth(body);
          setHealthError(null);
        }
      } catch (caught) {
        if (!cancelled) setHealthError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const rta = useMemo(() => {
    const status = getArrayStatus(topics);
    const dishes = getDishes(topics);
    return {
      array: status?.status ?? null,
      summary: summarizeDishes(dishes, status?.status ?? null),
    };
  }, [topics]);

  const mhe = useMemo(() => {
    const rooms = getRooms(topics);
    const crew = getCrew(topics);
    return { crew, summary: summarizeRooms(rooms, now) };
  }, [topics, now]);

  const opg = useMemo(() => {
    const power = getPower(topics);
    return { power, totals: computeTotals(power?.state ?? null) };
  }, [topics]);

  const activeAlerts = counts.ACTIVE;
  const topicCount = Object.keys(topics).length;
  const loadFactor =
    opg.totals.demandKw > 0 ? (opg.totals.producedKw / opg.totals.demandKw) * 100 : 0;

  return (
    <div className="space-y-5">
      <header className="relative overflow-hidden rounded-xl border border-console-edge/70 bg-console-panel/60 px-5 py-5 shadow-panel">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(720px 320px at 88% -40%, rgba(255,122,69,0.20), transparent 70%), radial-gradient(520px 260px at 4% 120%, rgba(111,92,255,0.14), transparent 72%)",
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kicker">Astro-Research Laboratory · Mars analogue station</p>
            <h1 className="hero-title mt-2">Mission control</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-console-muted">
              One ingestion pipeline (MQTT → SQLite → SSE) feeding three service consoles, with
              historical replay and audited alert handling.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={activeAlerts > 0 ? "alert" : "ok"}>
              <StatusDot tone={activeAlerts > 0 ? "alert" : "ok"} pulse={activeAlerts > 0} />
              {activeAlerts} active alert{activeAlerts === 1 ? "" : "s"}
            </Badge>
            <Badge tone={mode === "replay" ? "warn" : "info"}>
              {mode === "replay" ? "historical view" : `stream ${connection}`}
            </Badge>
            <span className="chip">{topicCount} topics</span>
            <span className="chip">
              last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt, now) : "—"}
            </span>
          </div>
        </div>
      </header>

      <ReplayBar />

      {(error || healthError) && (
        <div className="panel border-console-alert/40 bg-console-alert/5 px-4 py-2.5 text-xs text-console-alert">
          {error ?? healthError}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="Radio Telescope Array"
          subtitle="100 dishes, sub-array targeting and 1 Hz scan heatmap."
          accent="#ffc978"
          actions={<OpenLink href="/rta" />}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Metric
              label="Operational dishes"
              value={rta.summary.operational}
              unit={`/ ${rta.summary.registered}`}
              hint={`minimum ${RTA_MIN_OPERATIONAL_DISHES}`}
              tone={rta.summary.operational < RTA_MIN_OPERATIONAL_DISHES ? "alert" : "ok"}
            />
            <Metric
              label="Array state"
              value={rta.array?.status ?? "NO DATA"}
              hint={rta.array?.targetId ?? "no target"}
              tone={rta.array?.status === "SCANNING" ? "signal" : "neutral"}
            />
            <Metric
              label="Max dish temp"
              value={formatNumber(rta.summary.maxTemperatureC, 1)}
              unit="°C"
              tone={rta.summary.hotDishes > 0 ? "alert" : "neutral"}
            />
            <Metric
              label="Wind stow"
              value={rta.array?.windStow ? "ENGAGED" : "CLEAR"}
              hint={
                rta.array?.windStow
                  ? `releases below ${RTA_WIND_RELEASE_MS} m/s`
                  : `stows at ${RTA_WIND_STOW_LIMIT_MS} m/s gust`
              }
              tone={rta.array?.windStow ? "alert" : "ok"}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="w-24 text-[10px] uppercase tracking-[0.12em] text-console-muted">capacity</span>
            <div className="flex-1">
              <ProgressBar
                value={rta.summary.operational}
                max={Math.max(rta.summary.registered, 1)}
                tone={rta.summary.operational < RTA_MIN_OPERATIONAL_DISHES ? "alert" : "ok"}
              />
            </div>
            <span className="w-10 text-right font-mono text-[11px] text-console-ink">
              {ratio(rta.summary.operational, rta.summary.registered)}
            </span>
          </div>
        </Panel>

        <Panel
          title="Mars Habitation Experiment"
          subtitle="9-room habitat, crew vitals and twice-daily surveys."
          accent="#ff7a45"
          actions={<OpenLink href="/mhe" />}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Metric
              label="Rooms reporting"
              value={mhe.summary.roomsReporting}
              unit={`/ ${MHE_ROOMS.length}`}
              tone={mhe.summary.roomsReporting < MHE_ROOMS.length ? "warn" : "ok"}
            />
            <Metric
              label="Crew onboard"
              value={mhe.summary.crewOnboard}
              hint={`${mhe.crew.length} tracked`}
              tone={mhe.summary.crewOnboard > 0 ? "signal" : "neutral"}
            />
            <Metric
              label="Peak CO₂"
              value={formatNumber(mhe.summary.maxCo2Ppm, 0)}
              unit="ppm"
              tone={(mhe.summary.maxCo2Ppm ?? 0) >= MHE_CO2_LIMIT_PPM ? "alert" : "neutral"}
            />
            <Metric
              label="Habitat temp"
              value={formatNumber(mhe.summary.averageTemperatureC, 1)}
              unit="°C"
              hint={`${mhe.summary.staleRooms} stale room(s)`}
              tone={mhe.summary.staleRooms > 0 ? "warn" : "neutral"}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="w-24 text-[10px] uppercase tracking-[0.12em] text-console-muted">coverage</span>
            <div className="flex-1">
              <ProgressBar
                value={mhe.summary.roomsReporting}
                max={MHE_ROOMS.length}
                tone={mhe.summary.roomsReporting < MHE_ROOMS.length ? "warn" : "ok"}
              />
            </div>
            <span className="w-10 text-right font-mono text-[11px] text-console-ink">
              {mhe.summary.roomsReporting}/{MHE_ROOMS.length}
            </span>
          </div>
        </Panel>

        <Panel
          title="On-Demand Power Generation"
          subtitle="Solar, battery and diesel plant with load-shedding authority."
          accent="#8ab4ff"
          actions={<OpenLink href="/opg" />}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Metric
              label="Produced"
              value={formatNumber(opg.totals.producedKw, 1)}
              unit="kW"
              tone={opg.totals.deficitKw > 0 ? "alert" : "ok"}
            />
            <Metric
              label="Demand"
              value={formatNumber(opg.totals.demandKw, 1)}
              unit="kW"
              hint={opg.totals.deficitKw > 0 ? `${formatNumber(opg.totals.deficitKw, 1)} kW deficit` : "covered"}
            />
            <Metric
              label="Battery"
              value={formatNumber(opg.totals.batteryPct, 1)}
              unit="%"
              tone={
                (opg.totals.batteryPct ?? 100) <= OPG_BATTERY_CRITICAL_PCT ? "alert" : "neutral"
              }
            />
            <Metric
              label="Diesel fuel"
              value={formatNumber(opg.totals.fuelPct, 1)}
              unit="%"
              tone={(opg.totals.fuelPct ?? 100) <= OPG_DIESEL_LOW_FUEL_PCT ? "alert" : "neutral"}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="w-24 text-[10px] uppercase tracking-[0.12em] text-console-muted">coverage</span>
            <div className="flex-1">
              <ProgressBar
                value={loadFactor}
                max={100}
                tone={opg.totals.deficitKw > 0 ? "alert" : "ok"}
              />
            </div>
            <span className="w-10 text-right font-mono text-[11px] text-console-ink">
              {opg.totals.demandKw > 0 ? `${Math.round(loadFactor)}%` : "—"}
            </span>
          </div>
        </Panel>
      </div>

      <Panel
        title="ARL campus"
        subtitle="Facility footprints and the 100-dish phase-1 array, projected from the supplied arl.geojson."
        accent="#e8c8a4"
        actions={<span className="chip">campus site plan</span>}
      >
        <LabMap />
      </Panel>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="Platform health"
          subtitle="Environment contract, SQLite reachability and MQTT worker state."
        >
          <div className="space-y-2">
            {[
              {
                label: "environment",
                ok: health?.env.ok ?? false,
                detail: health?.env.ok ? "validated" : (health?.env.error ?? "not checked"),
              },
              {
                label: "sqlite",
                ok: health?.database.ok ?? false,
                detail: health?.database.ok
                  ? health.database.latestSampleAt
                    ? `latest sample ${timeAgo(health.database.latestSampleAt, now)}`
                    : "reachable · no samples yet"
                  : (health?.database.detail ?? "not checked"),
              },
              {
                label: "mqtt broker",
                ok: health?.mqtt.connected ?? false,
                detail: health
                  ? `${health.mqtt.state} · ${health.mqtt.messagesIngested} msgs · ${health.mqtt.alertsRaised} alerts`
                  : "not checked",
              },
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-2 text-xs">
                <StatusDot
                  tone={health === null ? "neutral" : row.ok ? "ok" : "alert"}
                  pulse={health !== null && !row.ok}
                />
                <span className="w-20 font-mono text-[10px] uppercase tracking-[0.12em] text-console-muted">
                  {row.label}
                </span>
                <span className="truncate text-console-ink">{row.detail}</span>
                <Badge tone={health === null ? "neutral" : row.ok ? "ok" : "alert"} className="ml-auto">
                  {health === null ? "…" : row.ok ? "ok" : "down"}
                </Badge>
              </div>
            ))}
          </div>

          <div className="mt-3 space-y-1 text-[11px] text-console-muted">
            <p>
              last MQTT message{" "}
              <span className="text-console-ink">
                {health?.mqtt.lastMessageAt ? timeAgo(health.mqtt.lastMessageAt, now) : "never"}
              </span>
            </p>
            {health?.mqtt.lastError && <p className="text-console-warn">worker: {health.mqtt.lastError}</p>}
            {health?.arlApi.docsUrl && (
              <p className="truncate">
                ARL API docs <span className="text-console-ink">{health.arlApi.docsUrl}</span>
              </p>
            )}
            {!health && !healthError && <p>probing…</p>}
          </div>
        </Panel>

        <div className="xl:col-span-2">
          <AlertAnnunciator title="Alert annunciator · all services" maxHeight="max-h-[420px]" />
        </div>
      </div>
    </div>
  );
}
