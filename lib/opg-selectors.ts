import {
  OPG_BATTERY_CRITICAL_PCT,
  OPG_DIESEL_LOW_FUEL_PCT,
  type OpgPowerState,
  type PowerSource,
  type TopicState,
} from "./types";

/** Pure derivations for the On-Demand Power Generation console. */

export interface PowerSnapshot {
  state: OpgPowerState;
  timestamp: string;
}

export interface SourceStatus {
  source: string;
  online: boolean;
  outputKw: number | null;
  timestamp: string;
}

export interface PowerTotals {
  solarKw: number;
  dieselKw: number;
  batteryKw: number;
  producedKw: number;
  demandKw: number;
  reserveKw: number;
  deficitKw: number;
  batteryPct: number | null;
  fuelPct: number | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getPower(topics: Record<string, TopicState>): PowerSnapshot | null {
  const entry = Object.values(topics).find((state) => state.topic.endsWith("/opg/power"));
  if (!entry) return null;
  return { state: entry.payload as unknown as OpgPowerState, timestamp: entry.timestamp };
}

export function getSources(topics: Record<string, TopicState>): SourceStatus[] {
  const sources: SourceStatus[] = [];
  for (const state of Object.values(topics)) {
    if (!/\/opg\/source\/[^/]+\/status$/.test(state.topic)) continue;
    const segments = state.topic.split("/");
    const index = segments.indexOf("source");
    const source = index >= 0 ? segments[index + 1] : null;
    if (!source) continue;
    const payload = state.payload as Record<string, unknown>;
    sources.push({
      source,
      online: payload.online === true || payload.status === "ONLINE",
      outputKw: num(payload.outputKw ?? payload.output),
      timestamp: state.timestamp,
    });
  }
  return sources.sort((a, b) => a.source.localeCompare(b.source));
}

export function computeTotals(state: OpgPowerState | null): PowerTotals {
  const solar = num(state?.solarOutputKw) ?? 0;
  const diesel = num(state?.dieselOutputKw) ?? 0;
  const battery = num(state?.batteryOutputKw) ?? 0;
  const demand = num(state?.demandKw) ?? 0;
  const reportedTotal = num((state as Record<string, unknown> | null)?.totalOutputKw);
  const produced = reportedTotal ?? Math.max(solar, 0) + Math.max(diesel, 0) + Math.max(battery, 0);

  return {
    solarKw: solar,
    dieselKw: diesel,
    batteryKw: battery,
    producedKw: produced,
    demandKw: demand,
    reserveKw: produced - demand,
    deficitKw: Math.max(0, demand - produced),
    batteryPct: num(state?.batteryCapacityPct),
    fuelPct: num(state?.dieselFuelPct),
  };
}

export interface DerivedAlert {
  tone: "warn" | "alert";
  message: string;
}

/** Client-side mirror of the OPG threshold rules for immediate surfacing. */
export function deriveOpgAlerts(state: OpgPowerState | null, totals: PowerTotals): DerivedAlert[] {
  if (!state) return [];
  const alerts: DerivedAlert[] = [];

  if (totals.demandKw > 0 && totals.producedKw < totals.demandKw) {
    alerts.push({
      tone: "alert",
      message: `Output ${totals.producedKw.toFixed(1)} kW < demand ${totals.demandKw.toFixed(1)} kW (${totals.deficitKw.toFixed(1)} kW short).`,
    });
  }

  if (totals.batteryPct !== null && totals.batteryPct <= OPG_BATTERY_CRITICAL_PCT) {
    alerts.push({
      tone: "alert",
      message: `Battery capacity ${totals.batteryPct.toFixed(1)}% ≤ ${OPG_BATTERY_CRITICAL_PCT}% critical threshold.`,
    });
  }

  if (totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT) {
    alerts.push({
      tone: "warn",
      message: `Diesel fuel ${totals.fuelPct.toFixed(1)}% ≤ ${OPG_DIESEL_LOW_FUEL_PCT}% reserve.`,
    });
  }

  if (state.solarEnabled !== false && state.inverterStatus && state.inverterStatus !== "ONLINE") {
    alerts.push({
      tone: "warn",
      message: `Solar inverter ${state.inverterStatus.toLowerCase()} while the array is enabled.`,
    });
  }

  if (state.solarEnabled !== false && totals.solarKw <= 0.5 && (state.demandKw ?? 0) > 0) {
    alerts.push({ tone: "warn", message: "Solar array enabled but reporting no output — unexpected generation drop." });
  }

  return alerts;
}

export const SOURCE_ORDER: PowerSource[] = ["SOLAR", "BATTERY", "DIESEL"];

export interface TrendPoint {
  t: number;
  solarKw: number;
  dieselKw: number;
  batteryKw: number;
  demandKw: number;
}

export function toTrendPoint(payload: Record<string, unknown>, timestamp: string): TrendPoint {
  const state = payload as unknown as OpgPowerState;
  return {
    t: Date.parse(timestamp),
    solarKw: num(state.solarOutputKw) ?? 0,
    dieselKw: num(state.dieselOutputKw) ?? 0,
    batteryKw: num(state.batteryOutputKw) ?? 0,
    demandKw: num(state.demandKw) ?? 0,
  };
}
