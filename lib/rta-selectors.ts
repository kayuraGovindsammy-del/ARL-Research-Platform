import { parseTopic } from "./topics";
import {
  RTA_DISH_COUNT,
  RTA_DISH_TEMP_WARN_C,
  RTA_MIN_OPERATIONAL_DISHES,
  kelvinToCelsius,
  radiansToDegrees,
  type DishCondition,
  type RtaArrayStatus,
  type RtaDishMetrics,
  type RtaScanContext,
  type RtaScanSample,
  type ScanState,
  type TopicState,
} from "./types";

/**
 * Pure derivations from the topic map, shared by the RTA panels.
 *
 * The simulator publishes one `telemetry/normal` sample per dish every 120 s
 * (`telemetry/scan` at 1 Hz while scanning) and keeps `state/<item>` retained,
 * so a dish's view model merges both sources: the stream for measurements and
 * the retained state for identity (enabled, stowed, sub-array, commanded
 * pointing).
 */

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

const SCAN_STATES: ScanState[] = [
  "IDLE",
  "SCHEDULED",
  "SCANNING",
  "PAUSED",
  "CANCELLED",
  "COMPLETE",
];

/** The service reports `running`; the UI calls that state `SCANNING`. */
const SCAN_STATE_ALIASES: Record<string, ScanState> = {
  idle: "IDLE",
  scheduled: "SCHEDULED",
  running: "SCANNING",
  scanning: "SCANNING",
  paused: "PAUSED",
  cancelled: "CANCELLED",
  complete: "COMPLETE",
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeScanState(value: unknown): ScanState {
  if (typeof value !== "string") return "IDLE";
  const normalized = SCAN_STATE_ALIASES[value.trim().toLowerCase()];
  if (normalized) return normalized;
  const upper = value.toUpperCase();
  return (SCAN_STATES as string[]).includes(upper) ? (upper as ScanState) : "IDLE";
}

/** Epoch milliseconds from a retained timestamp item, as ISO. */
function toIso(value: unknown): string | null {
  const ms = num(value);
  if (ms === null || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The array as a whole. `main` is the scanning sub-array researchers command;
 * `auto-2` and friends appear and disappear, so the member lists are read from
 * retained state rather than assumed.
 */
export function getArrayStatus(topics: Record<string, TopicState>): ArrayStatusState | null {
  const scanItem = findState(topics, "rta", "main", "scan_state");
  const online = findState(topics, "rta", "global", "online");
  if (!scanItem && !online) return null;

  const subArrays: Record<string, { dishIds: string[] }> = {};
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "RTA" || parsed.kind !== "state" || parsed.name !== "members") continue;
    const members = Array.isArray(state.payload.value)
      ? (state.payload.value as unknown[]).map((id) => String(id))
      : [];
    subArrays[parsed.entity ?? "main"] = { dishIds: members };
  }

  const activeAlerts = findState(topics, "rta", "global", "active_alerts");
  const target = parseTargetState(findState(topics, "rta", "main", "target")?.payload.value);

  const status: RtaArrayStatus = {
    status: normalizeScanState(scanItem?.payload.value),
    scanId: str(findState(topics, "rta", "main", "scan_id")?.payload.value),
    target: target.id,
    targetId: target.id,
    targetName: target.name,
    targetRaDeg: target.raDeg,
    targetDecDeg: target.decDeg,
    observationFrequencyHz: num(
      findState(topics, "rta", "main", "observation_frequency")?.payload.value,
    ),
    nextScanAt: toIso(findState(topics, "rta", "main", "next_scan")?.payload.value),
    windStow: bool(findState(topics, "rta", "global", "wind_stow")?.payload.value),
    activeDishes:
      num(findState(topics, "rta", "global", "active_dishes")?.payload.value) ?? undefined,
    operationalDishes:
      num(findState(topics, "rta", "global", "active_dishes")?.payload.value) ?? undefined,
    online: bool(online?.payload.value),
    activeAlerts: Array.isArray(activeAlerts?.payload.value)
      ? (activeAlerts!.payload.value as unknown[]).map(String)
      : [],
    subArrays,
    updatedAt: scanItem?.timestamp ?? online?.timestamp,
  };

  return { status, timestamp: status.updatedAt ?? new Date().toISOString() };
}

/**
 * The retained `target` item is either a catalogue id or — for a custom sky
 * position set by the operator — the object `{ra_rad, dec_rad, fov_rad}`.
 */
function parseTargetState(value: unknown): {
  id: string | null;
  name: string | null;
  raDeg: number | null;
  decDeg: number | null;
} {
  if (typeof value === "string") {
    const id = str(value);
    return { id, name: id, raDeg: null, decDeg: null };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const raDeg = radiansToDegrees(num(record.ra_rad));
    const decDeg = radiansToDegrees(num(record.dec_rad));
    return {
      id: "custom",
      name:
        raDeg !== null && decDeg !== null
          ? `RA ${raDeg.toFixed(2)}° · Dec ${decDeg.toFixed(2)}°`
          : "custom position",
      raDeg,
      decDeg,
    };
  }
  return { id: null, name: null, raDeg: null, decDeg: null };
}

function findState(
  topics: Record<string, TopicState>,
  service: string,
  entity: string,
  item: string,
): TopicState | null {
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (
      parsed.service === service.toUpperCase() &&
      parsed.kind === "state" &&
      parsed.entity === entity &&
      parsed.name === item
    ) {
      return state;
    }
  }
  return null;
}

function conditionFor(
  payload: Record<string, unknown>,
  enabled: boolean | undefined,
  stowed: boolean | undefined,
): DishCondition {
  if (enabled === false) return "DISABLED";
  if (stowed === true) return "STOWED";
  const fault = str(payload.fault_code);
  const status = bool(payload.status);
  if (status === false) return "OFFLINE";
  if (fault && fault !== "none") return "DEGRADED";
  return "OPERATIONAL";
}

/** Per-dish view model merged from `telemetry/normal|scan` and `state/*`. */
export function getDishes(topics: Record<string, TopicState>): DishEntry[] {
  const states = new Map<string, TopicState>();
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "RTA" || parsed.kind !== "state" || !parsed.entity) continue;
    states.set(`${parsed.entity}/${parsed.name}`, state);
  }

  const entries: DishEntry[] = [];
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "RTA" || parsed.kind !== "telemetry" || !parsed.entity) continue;
    if (parsed.name !== "normal" && parsed.name !== "scan") continue;
    if (!parsed.entity.startsWith("dish-")) continue;

    const payload = state.payload;
    const id = parsed.entity;
    const enabled = bool(states.get(`${id}/enabled`)?.payload.value);
    const stowed = bool(states.get(`${id}/stowed`)?.payload.value);
    const subArray = str(states.get(`${id}/subarray`)?.payload.value) ?? "main";
    const commanded = states.get(`${id}/commanded`)?.payload.value as
      | Record<string, unknown>
      | undefined;
    const lastCalibration = states.get(`${id}/last_calibration`)?.payload.value;

    const metrics: RtaDishMetrics = {
      dishId: id,
      subArray,
      condition: conditionFor(payload, enabled, stowed),
      temperatureC: kelvinToCelsius(num(payload.temperature_k)),
      systemTemperatureC: null,
      systemTemperatureK: num(payload.system_temperature_k),
      powerW: num(payload.power_w),
      azimuthDeg: radiansToDegrees(num(payload.azimuth_rad)),
      elevationDeg: radiansToDegrees(num(payload.elevation_rad)),
      commandedAzimuthDeg: radiansToDegrees(num(commanded?.azimuth_rad)),
      commandedElevationDeg: radiansToDegrees(num(commanded?.elevation_rad)),
      faultCode: str(payload.fault_code) ?? "none",
      enabled,
      stowed,
      lastCalibrationAt: toIso(lastCalibration),
      updatedAt: state.timestamp,
      scanId: str(payload.scan_id),
      scanProgress: num(payload.scan_progress),
      snrDb: num(payload.snr_db),
    };

    entries.push({
      id,
      metrics,
      subArray,
      condition: metrics.condition ?? "UNKNOWN",
      temperatureC: metrics.temperatureC ?? null,
      powerW: metrics.powerW ?? null,
      updatedAt: state.timestamp,
      topic: state.topic,
    });
  }

  if (entries.length === 0) {
    // Placeholder rack so the operator still sees the 100-dish layout.
    return Array.from({ length: RTA_DISH_COUNT }, (_, index) => ({
      id: `dish-${String(index + 1).padStart(3, "0")}`,
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
      if (dish.temperatureC >= RTA_DISH_TEMP_WARN_C) hotDishes += 1;
    }

    if (dish.powerW !== null) {
      powerSum += dish.powerW;
      powerCount += 1;
    }

    if (dish.updatedAt && (!lastMetricsAt || dish.updatedAt > lastMetricsAt)) {
      lastMetricsAt = dish.updatedAt;
    }
  }

  // Prefer the controller's own count: `active_dishes` is authoritative and is
  // republished whenever a dish enters or leaves service.
  const reportedOperational =
    typeof arrayStatus?.operationalDishes === "number"
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

export function dishTone(dish: DishEntry): "ok" | "warn" | "alert" | "neutral" {
  if (!dish.metrics) return "neutral";
  if (dish.temperatureC !== null && dish.temperatureC >= RTA_DISH_TEMP_WARN_C) return "alert";
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

  if (summary.registered > 0 && summary.operational < RTA_MIN_OPERATIONAL_DISHES) {
    alerts.push({
      tone: "alert",
      message: `Operational dishes ${summary.operational} — below the ${RTA_MIN_OPERATIONAL_DISHES}-dish minimum.`,
    });
  }

  if (arrayStatus?.windStow) {
    alerts.push({
      tone: "alert",
      message: "Wind stow engaged — all dishes pointed at zenith and scans paused.",
    });
  }

  if (summary.hotDishes > 0) {
    alerts.push({
      tone: "warn",
      message: `${summary.hotDishes} dish${summary.hotDishes === 1 ? "" : "es"} above ${RTA_DISH_TEMP_WARN_C.toFixed(
        1,
      )} °C.`,
    });
  }

  return alerts;
}

export interface ScanPoint {
  sample: RtaScanSample;
  timestamp: string;
}

/** Minimal shape of the SSE `event` channel payloads. */
export interface ServiceEventLike {
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * Name of the field a scan points at.
 *
 * `events/scan` sends the target as `{ra_rad, dec_rad, fov_rad}` rather than a
 * catalogue id, so fall back to a coordinate label instead of dropping the
 * identity and showing "unknown".
 */
export function scanTargetLabel(payload: Record<string, unknown>): string {
  const name = str(payload.target);
  if (name) return name;
  const ra = radiansToDegrees(num(payload.ra_rad));
  const dec = radiansToDegrees(num(payload.dec_rad));
  if (ra === null || dec === null) return "unknown";
  return `RA ${ra.toFixed(1)}° / Dec ${dec.toFixed(1)}°`;
}

/**
 * Geometry of the most recent scan that started, taken from
 * `arl/rta/events/scan` (`event: "started"`). The image grid only exists in
 * that event, so it is the one thing the canvas cannot derive from telemetry.
 */
export function getLatestScanContext(events: ServiceEventLike[]): RtaScanContext | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "scan") continue;
    if (str(event.payload.event) !== "started") continue;

    const scanId = str(event.payload.scan_id);
    const ra = num(event.payload.ra_rad);
    const dec = num(event.payload.dec_rad);
    const fov = num(event.payload.fov_rad);
    if (!scanId || ra === null || dec === null || fov === null) continue;

    return {
      scanId,
      target: scanTargetLabel(event.payload),
      raRad: ra,
      decRad: dec,
      fovRad: fov,
      bandHz: num(event.payload.band_hz) ?? 0,
      gridSize: num(event.payload.grid_size) ?? 128,
      overlap: num(event.payload.overlap) ?? 3,
      dishes: Array.isArray(event.payload.dishes)
        ? (event.payload.dishes as unknown[]).map(String)
        : [],
      expectedDurationS: num(event.payload.expected_duration_s) ?? 0,
      origin: str(event.payload.origin) ?? "command",
      startedAt: event.timestamp,
    };
  }
  return null;
}

/** Every `telemetry/scan` sample in the live ring buffer, in arrival order. */
export function getScanSamples(
  stream: Array<{ topic: string; payload: Record<string, unknown>; timestamp: string }>,
): ScanPoint[] {
  const points: ScanPoint[] = [];
  for (const event of stream) {
    const parsed = parseTopic(event.topic);
    if (parsed.service !== "RTA" || parsed.kind !== "telemetry" || parsed.name !== "scan") continue;
    if (!parsed.entity) continue;
    const payload = event.payload;
    points.push({
      sample: {
        dishId: parsed.entity,
        scanId: str(payload.scan_id),
        raOffsetRad: num(payload.pointing_offset_ra_rad),
        decOffsetRad: num(payload.pointing_offset_dec_rad),
        signalStrength: num(payload.signal_strength),
        snrDb: num(payload.snr_db),
        bandHz: num(payload.band_hz),
        scanProgress: num(payload.scan_progress),
        temperatureC: kelvinToCelsius(num(payload.temperature_k)),
        powerW: num(payload.power_w),
        faultCode: str(payload.fault_code) ?? "none",
        status: bool(payload.status),
      },
      timestamp: event.timestamp,
    });
  }
  return points;
}
