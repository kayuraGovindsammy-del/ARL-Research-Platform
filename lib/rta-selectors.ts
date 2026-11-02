import {
  RTA_DISH_COUNT,
  RTA_DISH_TEMP_LIMIT_C,
  RTA_MIN_OPERATIONAL_DISHES,
  RTA_WIND_STOW_LIMIT_MS,
  type DishCondition,
  type RtaArrayStatus,
  type RtaDishMetrics,
  type RtaScanSample,
  type TopicState,
} from "./types";

/** Pure derivations from the topic map, shared by the RTA panels. */

export interface DishEntry {
  id: string;
  metrics: RtaDishMetrics | null;
  subArray: string;
  condition: DishCondition | "UNKNOWN";
  temperatureC: number | null;
  powerW: number | null;
  updatedAt: string | null;
  topic: string | null;
}

export interface ArrayStatusState {
  status: RtaArrayStatus;
  timestamp: string;
}

export interface DishSummary {
  registered: number;
  operational: number;
  degraded: number;
  offline: number;
  disabled: number;
  stowed: number;
  unknown: number;
  averageTemperatureC: number | null;
  maxTemperatureC: number | null;
  hotDishes: number;
  totalPowerKW: number | null;
  lastMetricsAt: string | null;
}

export function getArrayStatus(topics: Record<string, TopicState>): ArrayStatusState | null {
  const entry = Object.values(topics).find((state) => state.topic.endsWith("/rta/array/status"));
  if (!entry) return null;
  return { status: entry.payload as RtaArrayStatus, timestamp: entry.timestamp };
}

function dishIdFromTopic(topic: string): string | null {
  const segments = topic.split("/");
  const index = segments.indexOf("dish");
  if (index === -1 || index + 1 >= segments.length) return null;
  return segments[index + 1] || null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCondition(value: unknown): DishCondition | "UNKNOWN" {
  if (typeof value !== "string") return "UNKNOWN";
  const upper = value.toUpperCase();
  if (
    upper === "OPERATIONAL" ||
    upper === "DEGRADED" ||
    upper === "OFFLINE" ||
    upper === "DISABLED" ||
    upper === "STOWED"
  ) {
    return upper;
  }
  return "UNKNOWN";
}

export function getDishes(topics: Record<string, TopicState>): DishEntry[] {
  const entries: DishEntry[] = [];

  for (const state of Object.values(topics)) {
    if (!/\/rta\/dish\/[^/]+\/metrics$/.test(state.topic)) continue;
    const id = dishIdFromTopic(state.topic);
    if (!id) continue;
    const payload = state.payload as unknown as RtaDishMetrics;
    entries.push({
      id: payload.dishId ?? id,
      metrics: payload,
      subArray: payload.subArray ?? "main",
      condition: normalizeCondition(payload.condition),
      temperatureC: asNumber(payload.temperatureC),
      powerW: asNumber(payload.powerW),
      updatedAt: state.timestamp,
      topic: state.topic,
    });
  }

  if (entries.length === 0) {
    // Placeholder rack so the operator still sees the 100-dish layout.
    return Array.from({ length: RTA_DISH_COUNT }, (_, index) => ({
      id: `D-${String(index + 1).padStart(3, "0")}`,
      metrics: null,
      subArray: "main",
      condition: "UNKNOWN" as const,
      temperatureC: null,
      powerW: null,
      updatedAt: null,
      topic: null,
    }));
  }

  return entries.sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function summarizeDishes(
  dishes: DishEntry[],
  arrayStatus: RtaArrayStatus | null,
): DishSummary {
  let operational = 0;
  let degraded = 0;
  let offline = 0;
  let disabled = 0;
  let stowed = 0;
  let unknown = 0;
  let temperatureSum = 0;
  let temperatureCount = 0;
  let maxTemperatureC: number | null = null;
  let hotDishes = 0;
  let powerSum = 0;
  let powerCount = 0;
  let lastMetricsAt: string | null = null;

  for (const dish of dishes) {
    if (!dish.metrics) {
      unknown += 1;
      continue;
    }
    switch (dish.condition) {
      case "OPERATIONAL":
        operational += 1;
        break;
      case "DEGRADED":
        degraded += 1;
        operational += 1;
        break;
      case "OFFLINE":
        offline += 1;
        break;
      case "DISABLED":
        disabled += 1;
        break;
      case "STOWED":
        stowed += 1;
        break;
      default:
        unknown += 1;
    }

    if (dish.temperatureC !== null) {
      temperatureSum += dish.temperatureC;
      temperatureCount += 1;
      if (maxTemperatureC === null || dish.temperatureC > maxTemperatureC) {
        maxTemperatureC = dish.temperatureC;
      }
      if (dish.temperatureC >= RTA_DISH_TEMP_LIMIT_C) hotDishes += 1;
    }

    if (dish.powerW !== null) {
      powerSum += dish.powerW;
      powerCount += 1;
    }

    if (dish.updatedAt && (!lastMetricsAt || dish.updatedAt > lastMetricsAt)) {
      lastMetricsAt = dish.updatedAt;
    }
  }

  // Prefer the count derived from per-dish metrics once every dish reports, so
  // the summary can never contradict the rack; fall back to the controller's
  // own count while telemetry is still partial.
  const reporting = dishes.filter((dish) => dish.metrics !== null).length;
  const allReporting = reporting > 0 && reporting === dishes.length;
  const reportedOperational =
    !allReporting && typeof arrayStatus?.operationalDishes === "number"
      ? arrayStatus.operationalDishes
      : operational;

  return {
    registered: dishes.length,
    operational: reportedOperational,
    degraded,
    offline,
    disabled,
    stowed,
    unknown,
    averageTemperatureC: temperatureCount > 0 ? temperatureSum / temperatureCount : null,
    maxTemperatureC,
    hotDishes,
    totalPowerKW: powerCount > 0 ? powerSum / 1000 : null,
    lastMetricsAt,
  };
}

export function dishTone(
  dish: DishEntry,
): "ok" | "warn" | "alert" | "neutral" {
  if (!dish.metrics) return "neutral";
  if (dish.temperatureC !== null && dish.temperatureC >= RTA_DISH_TEMP_LIMIT_C) return "alert";
  if (dish.condition === "OFFLINE" || dish.condition === "DISABLED") return "alert";
  if (dish.condition === "STOWED" || dish.condition === "DEGRADED") return "warn";
  return "ok";
}

export interface DerivedAlert {
  tone: "warn" | "alert";
  message: string;
}

/** Client-side mirror of the ingestion thresholds, for immediate surfacing. */
export function deriveRtaAlerts(
  summary: DishSummary,
  arrayStatus: RtaArrayStatus | null,
): DerivedAlert[] {
  const alerts: DerivedAlert[] = [];
  const hasDishData = summary.unknown < summary.registered || summary.registered === 0;

  if (summary.registered > 0 && hasDishData && summary.operational < RTA_MIN_OPERATIONAL_DISHES) {
    alerts.push({
      tone: "alert",
      message: `Operational dishes ${summary.operational} — below the ${RTA_MIN_OPERATIONAL_DISHES}-dish minimum.`,
    });
  }

  const wind = asNumber(arrayStatus?.windSpeedMs);
  if (wind !== null && wind >= RTA_WIND_STOW_LIMIT_MS) {
    alerts.push({
      tone: "alert",
      message: `Wind ${wind.toFixed(1)} m/s ≥ ${RTA_WIND_STOW_LIMIT_MS} m/s — emergency stowage required.`,
    });
  }

  if (summary.hotDishes > 0) {
    alerts.push({
      tone: "warn",
      message: `${summary.hotDishes} dish${summary.hotDishes === 1 ? "" : "es"} above ${RTA_DISH_TEMP_LIMIT_C} °C.`,
    });
  }

  return alerts;
}

export interface ScanPoint {
  sample: RtaScanSample;
  timestamp: string;
}

export function getScanSamples(stream: Array<{ topic: string; payload: Record<string, unknown>; timestamp: string }>): ScanPoint[] {
  const points: ScanPoint[] = [];
  for (const event of stream) {
    if (!/\/rta\/scan\/[^/]+\/sample$/.test(event.topic)) continue;
    points.push({
      sample: event.payload as RtaScanSample,
      timestamp: event.timestamp,
    });
  }
  return points;
}
