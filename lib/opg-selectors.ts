import { parseTopic } from "./topics";
import {
  OPG_BATTERY_CRITICAL_PCT,
  OPG_DIESEL_LOW_FUEL_PCT,
  kelvinToCelsius,
  wattsToKilowatts,
  type OpgPowerState,
  type PowerSource,
  type TopicState,
} from "./types";

/**
 * Pure derivations for the On-Demand Power Generation console.
 *
 * The plant publishes four `telemetry/power` streams — global (generation and
 * load totals), solar, batteries and diesel — plus retained `state` items for
 * the operator's intent. Everything is reported in watts and kelvin, so the
 * selector converts to kW and °C once, here.
 */

export interface PowerSnapshot {
  state: OpgPowerState;
  timestamp: string;
}

export interface SourceStatus {
  source: string;
  online: boolean;
  outputKw: number | null;
  detail: string | null;
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

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function findPower(topics: Record<string, TopicState>, entity: string): TopicState | null {
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service === "OPG" && parsed.entity === entity && parsed.name === "power") {
      return state;
    }
  }
  return null;
}

function findState(topics: Record<string, TopicState>, entity: string, item: string): unknown {
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (
      parsed.service === "OPG" &&
      parsed.kind === "state" &&
      parsed.entity === entity &&
      parsed.name === item
    ) {
      return state.payload.value;
    }
  }
  return undefined;
}

export function getPower(topics: Record<string, TopicState>): PowerSnapshot | null {
  const global = findPower(topics, "global");
  if (!global) return null;

  const solar = findPower(topics, "solar");
  const batteries = findPower(topics, "batteries");
  const diesel = findPower(topics, "diesel");

  const state: OpgPowerState = {
    totalGenerationKw: wattsToKilowatts(num(global.payload.total_generation_w)),
    totalLoadKw: wattsToKilowatts(num(global.payload.total_load_w)),
    supplyMode: str(global.payload.supply_mode) ?? undefined,
    solarOutputKw: wattsToKilowatts(num(solar?.payload.power_output_w)),
    irradianceWm2: num(solar?.payload.irradiance_wm2),
    panelTemperatureC: kelvinToCelsius(num(solar?.payload.panel_temperature_k)),
    inverterStatus: str(solar?.payload.inverter_status) ?? undefined,
    solarEnabled: bool(findState(topics, "solar", "enabled")),
    batteryCapacityPct: num(batteries?.payload.state_of_charge_pct),
    batteryOutputKw: wattsToKilowatts(num(batteries?.payload.battery_power_w)),
    batteryTemperatureC: kelvinToCelsius(num(batteries?.payload.battery_temperature_k)),
    batteryHealthPct: num(batteries?.payload.battery_health_pct),
    batteryReservePct: num(findState(topics, "batteries", "reserve_pct")),
    dieselFuelPct: num(diesel?.payload.fuel_level_pct),
    dieselOutputKw: wattsToKilowatts(num(diesel?.payload.power_output_w)),
    generatorStatus: str(diesel?.payload.generator_status) ?? undefined,
    dieselRuntimeH: num(diesel?.payload.runtime_h),
    generationPriority: str(findState(topics, "global", "generation_priority")) ?? undefined,
    loadShed: bool(findState(topics, "global", "load_shed")),
    updatedAt: global.timestamp,
  };

  return { state, timestamp: global.timestamp };
}

/** Per-source controller view, built from the four power streams. */
export function getSources(topics: Record<string, TopicState>): SourceStatus[] {
  const solar = findPower(topics, "solar");
  const batteries = findPower(topics, "batteries");
  const diesel = findPower(topics, "diesel");

  const sources: SourceStatus[] = [];
  if (solar) {
    const status = str(solar.payload.inverter_status) ?? "unknown";
    sources.push({
      source: "solar",
      online: status === "online",
      outputKw: wattsToKilowatts(num(solar.payload.power_output_w)),
      detail: `inverter ${status} · ${Math.round(num(solar.payload.irradiance_wm2) ?? 0)} W/m²`,
      timestamp: solar.timestamp,
    });
  }
  if (batteries) {
    sources.push({
      source: "batteries",
      online: true,
      outputKw: wattsToKilowatts(num(batteries.payload.battery_power_w)),
      detail: `${(num(batteries.payload.state_of_charge_pct) ?? 0).toFixed(1)} % SoC · health ${(
        num(batteries.payload.battery_health_pct) ?? 0
      ).toFixed(0)} %`,
      timestamp: batteries.timestamp,
    });
  }
  if (diesel) {
    const status = str(diesel.payload.generator_status) ?? "off";
    sources.push({
      source: "diesel",
      online: status === "running",
      outputKw: wattsToKilowatts(num(diesel.payload.power_output_w)),
      detail: `generator ${status} · ${(num(diesel.payload.fuel_level_pct) ?? 0).toFixed(1)} % fuel`,
      timestamp: diesel.timestamp,
    });
  }
  return sources;
}

export function computeTotals(state: OpgPowerState | null): PowerTotals {
  const solar = num(state?.solarOutputKw) ?? 0;
  const diesel = num(state?.dieselOutputKw) ?? 0;
  const battery = num(state?.batteryOutputKw) ?? 0;
  const demand = num(state?.totalLoadKw) ?? 0;
  const reportedTotal = num(state?.totalGenerationKw);
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
      message: `Battery capacity ${totals.batteryPct.toFixed(1)}% ≤ ${OPG_BATTERY_CRITICAL_PCT}% warning threshold.`,
    });
  }

  if (totals.fuelPct !== null && totals.fuelPct <= OPG_DIESEL_LOW_FUEL_PCT) {
    alerts.push({
      tone: "warn",
      message: `Diesel fuel ${totals.fuelPct.toFixed(1)}% ≤ ${OPG_DIESEL_LOW_FUEL_PCT}% reserve.`,
    });
  }

  if (state.solarEnabled !== false && state.inverterStatus && state.inverterStatus !== "online") {
    alerts.push({
      tone: "warn",
      message: `Solar inverter ${state.inverterStatus} while the array is enabled.`,
    });
  }

  if (state.batteryTemperatureC !== null && state.batteryTemperatureC !== undefined) {
    const limitC = 318 - 273.15;
    if (state.batteryTemperatureC >= limitC) {
      alerts.push({
        tone: "alert",
        message: `Battery temperature ${state.batteryTemperatureC.toFixed(1)} °C above ${limitC.toFixed(
          1,
        )} °C.`,
      });
    }
  }

  if ((state.generatorStatus ?? "off") !== "off" && (state.generatorStatus ?? "") !== "running") {
    alerts.push({
      tone: "warn",
      message: `Diesel generator is ${state.generatorStatus}.`,
    });
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

/** One aggregated `arl/opg/global/telemetry/power` sample as a chart point. */
export function toTrendPoint(payload: Record<string, unknown>, timestamp: string): TrendPoint {
  return {
    t: Date.parse(timestamp),
    solarKw: wattsToKilowatts(num(payload.total_generation_w)) ?? 0,
    dieselKw: 0,
    batteryKw: 0,
    demandKw: wattsToKilowatts(num(payload.total_load_w)) ?? 0,
  };
}

/** Chart point that combines the per-source streams with the global totals. */
export function toCombinedTrendPoint(
  state: OpgPowerState | null,
  timestamp: string,
): TrendPoint {
  const totals = computeTotals(state);
  return {
    t: Date.parse(timestamp),
    solarKw: Math.max(totals.solarKw, 0),
    dieselKw: Math.max(totals.dieselKw, 0),
    batteryKw: Math.max(totals.batteryKw, 0),
    demandKw: totals.demandKw,
  };
}
