/**
 * Shared domain contract between the ingestion pipeline, the API routes and the
 * browser dashboards. Payload interfaces are intentionally permissive: the lab
 * firmware may add fields, and dashboards must tolerate partial snapshots.
 */

export const SERVICES = ["RTA", "MHE", "OPG"] as const;
export type Service = (typeof SERVICES)[number];

export function isService(value: string): value is Service {
  return (SERVICES as readonly string[]).includes(value.toUpperCase());
}

export function toService(value: string): Service | null {
  const upper = value.toUpperCase();
  return isService(upper) ? (upper as Service) : null;
}

export const ALERT_STATUSES = ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface AlertRecord {
  id: string;
  service: string;
  alertType: string;
  message: string;
  status: AlertStatus;
  timestamp: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** One telemetry sample as pushed over SSE / returned by the replay API. */
export interface TelemetryEvent {
  id: string;
  service: Service;
  topic: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/** Materialised latest value of a topic, keyed by topic name. */
export interface TopicState {
  topic: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface ReplaySnapshot {
  targetTime: string;
  service: Service | null;
  topics: Record<string, TopicState>;
  count: number;
}

// ---------------------------------------------------------------------------
// Explicit alert flags that may be embedded in any telemetry payload.
// ---------------------------------------------------------------------------
export interface AlertFlag {
  type: string;
  message: string;
}

// ---------------------------------------------------------------------------
// RTA — Radio Telescope Array
// ---------------------------------------------------------------------------
export type DishCondition =
  | "OPERATIONAL"
  | "DEGRADED"
  | "OFFLINE"
  | "DISABLED"
  | "STOWED";

export interface RtaDishMetrics {
  dishId: string;
  subArray?: string;
  condition?: DishCondition;
  temperatureC?: number;
  powerW?: number;
  azimuthDeg?: number;
  elevationDeg?: number;
  targetId?: string | null;
  updatedAt?: string;
}

export interface RtaArrayStatus {
  status?: "IDLE" | "SCANNING" | "PAUSED" | "STOWED" | "CANCELLED";
  scanId?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  windSpeedMs?: number;
  operationalDishes?: number;
  subArrays?: Record<string, { dishIds?: string[]; label?: string }>;
  startedAt?: string | null;
  updatedAt?: string;
}

export interface RtaScanSample {
  scanId?: string;
  sampleIndex?: number;
  frequencyMhz?: number;
  offsetAzDeg?: number;
  offsetElDeg?: number;
  value?: number;
  dishId?: string;
}

export const RTA_DISH_COUNT = 100;
export const RTA_DISH_TEMP_LIMIT_C = 65;
export const RTA_MIN_OPERATIONAL_DISHES = 80;
export const RTA_WIND_STOW_LIMIT_MS = 22;

// ---------------------------------------------------------------------------
// MHE — Mars Habitation Experiment
// ---------------------------------------------------------------------------
export const MHE_ROOMS = [
  "quarters-1",
  "quarters-2",
  "quarters-3",
  "quarters-4",
  "quarters-5",
  "common",
  "lab",
  "hydroponics",
  "airlock",
] as const;
export type MheRoomId = (typeof MHE_ROOMS)[number];

export const MHE_CREW = [
  "crew-1",
  "crew-2",
  "crew-3",
  "crew-4",
  "crew-5",
] as const;
export type MheCrewId = (typeof MHE_CREW)[number];

export interface MheRoomTelemetry {
  roomId?: string;
  temperatureC?: number;
  crewCount?: number;
  o2Pct?: number;
  co2Ppm?: number;
  pressurized?: boolean;
  airlockState?: "PRESSURIZED" | "DEPRESSURIZED" | "CYCLING";
  lightLevelPct?: number;
  updatedAt?: string;
}

export interface MheCrewHealth {
  crewId?: string;
  name?: string;
  heartRateBpm?: number;
  bodyTempC?: number;
  updatedAt?: string;
}

export interface MheCrewSurvey {
  crewId?: string;
  missionDay?: number;
  mood?: number;
  stress?: number;
  fatigue?: number;
  sleepQuality?: number;
  submittedAt?: string;
}

export const MHE_CO2_LIMIT_PPM = 5000;
export const MHE_HEART_RATE_LIMIT_BPM = 130;
export const MHE_SURVEY_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const MHE_TELEMETRY_STALE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// OPG — On-Demand Power Generation
// ---------------------------------------------------------------------------
export type PowerSource = "SOLAR" | "BATTERY" | "DIESEL";

export interface OpgPowerState {
  solarOutputKw?: number;
  solarCapacityKw?: number;
  solarEnabled?: boolean;
  inverterStatus?: "ONLINE" | "OFFLINE" | "FAULT" | "STANDBY";
  batteryCapacityPct?: number;
  batteryOutputKw?: number;
  dieselOutputKw?: number;
  dieselFuelPct?: number;
  dieselRunning?: boolean;
  demandKw?: number;
  activeSource?: PowerSource;
  loadShedding?: boolean;
  shedLoadKw?: number;
  updatedAt?: string;
}

export const OPG_BATTERY_CRITICAL_PCT = 20;
export const OPG_DIESEL_LOW_FUEL_PCT = 15;

// ---------------------------------------------------------------------------
// Commands published by the control API to `arl/<service>/cmd/...`.
// ---------------------------------------------------------------------------
export type ControlCommand =
  | { service: "RTA"; action: "scan.start"; targetId: string; custom?: boolean; ra?: number; dec?: number }
  | { service: "RTA"; action: "scan.pause" }
  | { service: "RTA"; action: "scan.resume" }
  | { service: "RTA"; action: "scan.cancel" }
  | { service: "RTA"; action: "dish.disable"; dishId: string }
  | { service: "RTA"; action: "dish.enable"; dishId: string }
  | { service: "RTA"; action: "dish.stow"; dishId: string }
  | { service: "RTA"; action: "array.stow" }
  | { service: "RTA"; action: "array.subArray"; dishId: string; subArray: string }
  | { service: "MHE"; action: "room.temperature"; roomId: string; temperatureC: number }
  | { service: "MHE"; action: "room.light"; roomId: string; lightLevelPct: number }
  | { service: "MHE"; action: "crew.wellnessCheck"; crewId: string }
  | { service: "MHE"; action: "airlock.pressurize"; roomId: string }
  | { service: "OPG"; action: "source.select"; source: PowerSource }
  | { service: "OPG"; action: "loadShedding.enable" }
  | { service: "OPG"; action: "loadShedding.disable" }
  | { service: "OPG"; action: "solar.enable" }
  | { service: "OPG"; action: "solar.disable" }
  | { service: "OPG"; action: "diesel.start" }
  | { service: "OPG"; action: "diesel.stop" };

export interface CommandEnvelope {
  action: string;
  issuedBy: string;
  issuedAt: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ARL REST API documents
// ---------------------------------------------------------------------------
export interface ArlTarget {
  id: string;
  name: string;
  ra?: number;
  dec?: number;
  frequencyMhz?: number;
  description?: string;
}

export interface ArlLabMetadata {
  labId?: string;
  name?: string;
  location?: string;
  operator?: string;
  services?: string[];
  [key: string]: unknown;
}

export interface ArlParameter {
  id?: string;
  name: string;
  value?: number | string | boolean;
  unit?: string;
  description?: string;
  [key: string]: unknown;
}
