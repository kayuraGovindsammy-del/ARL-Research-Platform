/**
 * Shared domain contract between the ingestion pipeline, the API routes and the
 * browser dashboards.
 *
 * The wire format is the ARL simulator's, captured from a live `$topology`
 * document: `arl/<service>/<entity>/telemetry/<stream>` carries
 * `{v, ts, seq, entity, ...fields}`, `.../state/<item>` carries
 * `{v, ts, entity, item, value}` and `arl/<service>/events/<kind>` carries an
 * event object. Dashboards never see those raw shapes — selectors convert them
 * into the view models declared below, converting units on the way
 * (K → °C, rad → °, Hz → MHz, W → kW).
 */

export const SERVICES = ["RTA", "MHE", "OPG", "LWM"] as const;
export type Service = (typeof SERVICES)[number];

/** Services we ingest — the same four the platform renders. */
export const INGEST_SERVICES = ["RTA", "MHE", "OPG", "LWM"] as const;
export type IngestService = (typeof INGEST_SERVICES)[number];

export function isService(value: string): value is Service {
  return (SERVICES as readonly string[]).includes(value.toUpperCase());
}

export function toService(value: string): Service | null {
  const upper = value.toUpperCase();
  return isService(upper) ? (upper as Service) : null;
}

export function toIngestService(value: string): IngestService | null {
  const upper = value.toUpperCase();
  return (INGEST_SERVICES as readonly string[]).includes(upper)
    ? (upper as IngestService)
    : null;
}

export const ALERT_STATUSES = ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * A persisted alert, including the full decision context the annunciator
 * needs: who raised/acknowledged/resolved it and when, and the cause (rule,
 * entity, measured value against its limit).
 */
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
  cause: string | null;
  severity: string | null;
  entity: string | null;
  value: number | null;
  limitValue: number | null;
  unit: string | null;
  /** JSON blob: rule id, service metadata and the suggested action. */
  context: string | null;
}

export function alertSeverity(alert: Pick<AlertRecord, "severity">): AlertSeverity {
  const value = (alert.severity ?? "").toLowerCase();
  return (ALERT_SEVERITIES as readonly string[]).includes(value)
    ? (value as AlertSeverity)
    : "warning";
}

/** One telemetry sample as pushed over SSE / returned by the replay API. */
export interface TelemetryEvent {
  id: string;
  service: IngestService;
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
  /** Present on cursor snapshots; absent from the lightweight bounds query. */
  context?: ReplayContext;
}

/**
 * Alerts as they stood at the replay cursor, so replay is not just charts: the
 * operator sees the alerts that were live at that moment and the service
 * events that happened around it.
 */
export interface ReplayContext {
  /** Alerts raised at or before the cursor and not yet resolved. */
  activeAlerts: AlertRecord[];
  /** Alerts raised inside the look-back window, whatever their current state. */
  recentAlerts: AlertRecord[];
  /** `events/*` samples inside the look-back window, oldest first. */
  events: Array<{
    service: string;
    kind: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }>;
  windowMs: number;
}

// ---------------------------------------------------------------------------
// Envelope + shared unit conversions
// ---------------------------------------------------------------------------

/** Every ARL message carries this envelope. */
export interface ArlEnvelope {
  v: number;
  ts: number;
  seq?: number;
  entity?: string;
}

export const KELVIN_OFFSET = 273.15;
export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;

export function kelvinToCelsius(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value - KELVIN_OFFSET : null;
}

export function celsiusToKelvin(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value + KELVIN_OFFSET : null;
}

export function radiansToDegrees(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * RAD_TO_DEG : null;
}

export function degreesToRadians(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * DEG_TO_RAD : null;
}

export function hertzToMegahertz(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value / 1e6 : null;
}

export function megahertzToHertz(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1e6 : null;
}

export function wattsToKilowatts(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value / 1000 : null;
}

// ---------------------------------------------------------------------------
// Alert limits (GET /v1/alert-limits/{service})
// ---------------------------------------------------------------------------

export interface AlertLimit {
  key: string;
  value: number;
  unit: string | null;
}

export type AlertLimits = Record<string, AlertLimit>;

/**
 * Fallbacks copied from a live `/v1/alert-limits/{service}` response, used for
 * client-side derivation while the API call is still in flight or unavailable.
 */
export const DEFAULT_ALERT_LIMITS: Record<Service, Record<string, number>> = {
  RTA: {
    "availability.min_active": 80,
    "wind_stow.gust_ms": 15,
    "wind_stow.release_ms": 10,
    "dish_temperature.warn_k": 333,
    "dish_temperature.crit_k": 343,
    "dish_power.max_w": 5000,
    "scan.min_snr_db": 3,
    "calibration.max_age_h": 168,
  },
  MHE: {
    "air.co2_crit_ppm": 2500,
    "air.co2_warn_ppm": 1500,
    "air.o2_min_ppm": 195000,
    "crew.hr_max": 150,
    "crew.hr_min": 40,
    "crew.resp_max": 30,
    "crew.spo2_min": 92,
    "crew.temp_max_k": 311.15,
    "room.humidity_max": 75,
    "room.humidity_max_hydroponics": 85,
    "room.humidity_min": 25,
    "room.temp_max_k": 298,
    "room.temp_min_k": 290,
    "survey.max_decline": 2,
    "survey.max_stress": 7,
    "survey.min_mood": 4,
  },
  OPG: {
    "battery.max_temp_k": 318,
    "battery.warn_pct": 30,
    "fuel.min_pct": 25,
    "solar.min_ratio": 0.8,
  },
  /*
   * LWM does not publish an alert-rule document, so these are the thresholds
   * this platform warns at — each one is a weather condition that changes what
   * the array or the power plant can do.
   */
  LWM: {
    "wind.gust_warn_ms": 12,
    "wind.gust_stow_ms": 15,
    "irradiance.soiling_warn_ratio": 0.9,
    "station.battery_low_v": 11.8,
    "station.stale_ms": 300000,
  },
};

export function limitValue(
  limits: AlertLimits | null | undefined,
  service: Service,
  key: string,
): number {
  return limits?.[key]?.value ?? DEFAULT_ALERT_LIMITS[service][key];
}

/**
 * Thresholds the dashboards render as hints. They mirror the service defaults,
 * which is what the simulator ships with; the authoritative values live in
 * `/v1/alert-limits/{service}` and drive the alerts the services raise.
 */
export const RTA_MIN_OPERATIONAL_DISHES =
  DEFAULT_ALERT_LIMITS.RTA["availability.min_active"];
export const RTA_WIND_STOW_LIMIT_MS = DEFAULT_ALERT_LIMITS.RTA["wind_stow.gust_ms"];
export const RTA_WIND_RELEASE_MS = DEFAULT_ALERT_LIMITS.RTA["wind_stow.release_ms"];
/** 333 K warn / 343 K critical, expressed in the unit the UI displays. */
export const RTA_DISH_TEMP_WARN_C = kelvinToCelsius(
  DEFAULT_ALERT_LIMITS.RTA["dish_temperature.warn_k"],
)!;
export const RTA_DISH_TEMP_CRIT_C = kelvinToCelsius(
  DEFAULT_ALERT_LIMITS.RTA["dish_temperature.crit_k"],
)!;
export const MHE_CO2_WARN_PPM = DEFAULT_ALERT_LIMITS.MHE["air.co2_warn_ppm"];
export const MHE_CO2_LIMIT_PPM = DEFAULT_ALERT_LIMITS.MHE["air.co2_crit_ppm"];
export const MHE_HEART_RATE_LIMIT_BPM = DEFAULT_ALERT_LIMITS.MHE["crew.hr_max"];
export const MHE_SPO2_MIN_PCT = DEFAULT_ALERT_LIMITS.MHE["crew.spo2_min"];
export const MHE_BODY_TEMP_MAX_C = kelvinToCelsius(
  DEFAULT_ALERT_LIMITS.MHE["crew.temp_max_k"],
)!;

// ---------------------------------------------------------------------------
// Topology ($topology, retained per service)
// ---------------------------------------------------------------------------

export interface TopologyEntity {
  id: string;
  kind: string;
  row?: number;
  col?: number;
  lat?: number;
  lon?: number;
}

export interface TopologyField {
  key: string;
  type: string;
  unit?: string | null;
  values?: string[];
}

export interface TopologyStream {
  topic: string;
  entity_kinds?: string[];
  period_s?: number;
  fields?: TopologyField[];
}

export interface TopologyControl {
  topic: string;
  entity_kinds?: string[];
  value: {
    type: string;
    unit?: string;
    min?: number;
    max?: number;
    values?: string[];
    fields?: Array<{ key: string; type: string; unit?: string }>;
  };
}

export interface Topology {
  v: number;
  service: string;
  version: string;
  entities: TopologyEntity[];
  streams: TopologyStream[];
  state: Array<{ topic: string; entity_kinds?: string[] }>;
  events: Array<{ topic: string }>;
  controls: TopologyControl[];
}

// ---------------------------------------------------------------------------
// RTA — Radio Telescope Array
// ---------------------------------------------------------------------------

/** `scan_state` as reported by the sub-array, normalised for the UI. */
export type ScanState =
  | "IDLE"
  | "SCHEDULED"
  | "SCANNING"
  | "PAUSED"
  | "CANCELLED"
  | "COMPLETE";

export type DishCondition =
  | "OPERATIONAL"
  | "DEGRADED"
  | "OFFLINE"
  | "DISABLED"
  | "STOWED";

/** Per-dish view model, merged from `telemetry/normal` + `state/*`. */
export interface RtaDishMetrics {
  dishId: string;
  subArray?: string;
  condition?: DishCondition;
  temperatureC?: number | null;
  /** Receiver noise temperature; the service reports it in kelvin already. */
  systemTemperatureK?: number | null;
  systemTemperatureC?: number | null;
  powerW?: number | null;
  azimuthDeg?: number | null;
  elevationDeg?: number | null;
  commandedAzimuthDeg?: number | null;
  commandedElevationDeg?: number | null;
  faultCode?: string;
  enabled?: boolean;
  stowed?: boolean;
  lastCalibrationAt?: string | null;
  /** Present on `telemetry/scan` samples only. */
  scanId?: string | null;
  scanProgress?: number | null;
  snrDb?: number | null;
  updatedAt?: string;
}

export interface RtaArrayStatus {
  status: ScanState;
  scanId?: string | null;
  /** Catalogue id or "custom" for an ad-hoc sky position. */
  target?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  targetRaDeg?: number | null;
  targetDecDeg?: number | null;
  observationFrequencyHz?: number | null;
  nextScanAt?: string | null;
  /** Wind stow is a boolean on this service; the gust itself comes from LWM. */
  windStow?: boolean;
  operationalDishes?: number;
  activeDishes?: number;
  online?: boolean;
  activeAlerts?: string[];
  subArrays?: Record<string, { dishIds?: string[]; label?: string }>;
  startedAt?: string | null;
  updatedAt?: string;
}

/** One row of `arl/rta/<dish>/telemetry/scan` (1 Hz while scanning). */
export interface RtaScanSample {
  dishId: string;
  scanId?: string | null;
  raOffsetRad?: number | null;
  decOffsetRad?: number | null;
  signalStrength?: number | null;
  snrDb?: number | null;
  bandHz?: number | null;
  scanProgress?: number | null;
  temperatureC?: number | null;
  powerW?: number | null;
  faultCode?: string;
  status?: boolean;
}

/** `arl/rta/events/scan` with `event: "started"`. */
export interface RtaScanContext {
  scanId: string;
  target: string;
  raRad: number;
  decRad: number;
  fovRad: number;
  bandHz: number;
  gridSize: number;
  overlap: number;
  dishes: string[];
  expectedDurationS: number;
  origin: string;
  startedAt: string;
}

export const RTA_DISH_COUNT = 100;
export const RTA_SCAN_GRID_DEFAULT = 128;

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

export const MHE_CREW = ["crew-1", "crew-2", "crew-3", "crew-4", "crew-5"] as const;
export type MheCrewId = (typeof MHE_CREW)[number];

export interface MheRoomTelemetry {
  roomId: string;
  temperatureC?: number | null;
  humidityPct?: number | null;
  oxygenPpm?: number | null;
  /** Oxygen is reported in ppm; the UI reads it as a percentage. */
  o2Pct?: number | null;
  co2Ppm?: number | null;
  pressureKpa?: number | null;
  lightingLux?: number | null;
  ventilationM3h?: number | null;
  crewCount?: number | null;
  /** Airlock stream (`arl/mhe/airlock/telemetry/airlock`), airlock room only. */
  airlockState?: "pressurised" | "depressurised" | "cycling" | string | null;
  pressurized?: boolean;
  innerDoor?: string | null;
  outerDoor?: string | null;
  evaInProgress?: boolean;
  updatedAt?: string;
}

/** `airlock` stream (airlock room only). */
export interface MheAirlockState {
  airlockState?: "pressurised" | "depressurised" | "cycling" | string;
  evaInProgress?: boolean;
  innerDoor?: string;
  outerDoor?: string;
}

export interface MheHydroponics {
  waterLevelL?: number | null;
  waterPh?: number | null;
  nutrientEcMscm?: number | null;
  growthStage?: string;
  estimatedYieldKg?: number | null;
}

export interface MheSetpoints {
  temperatureC?: number | null;
  humidityPct?: number | null;
  ventilationM3h?: number | null;
}

export interface MheLightingSchedule {
  start: string;
  end: string;
  levelLux: number;
}

export interface MheCrewHealth {
  crewId: string;
  name?: string;
  heartRateBpm?: number | null;
  bodyTemperatureC?: number | null;
  respiratoryRateBpm?: number | null;
  spo2Pct?: number | null;
  movement?: number | null;
  location?: string;
  updatedAt?: string;
}

/** `arl/mhe/global/telemetry/habitat` (wire shape). */
export interface MheHabitatTelemetry {
  mission_day?: number | null;
  power_w?: number | null;
}

export interface MheCrewSurvey {
  crewId: string;
  surveyType?: "start_of_day" | "end_of_day" | string;
  missionDay?: number;
  mood?: number;
  stress?: number;
  fatigue?: number;
  sleepQuality?: number;
  submittedAt?: string;
}

export interface MheSubsystems {
  [subsystem: string]: "ok" | "degraded" | "fault" | string;
}

export const MHE_SURVEY_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const MHE_TELEMETRY_STALE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// OPG — On-Demand Power Generation
// ---------------------------------------------------------------------------

export type PowerSource = "SOLAR" | "BATTERY" | "DIESEL";
export type GenerationPriority = "solar_first" | "battery_first" | "diesel_first";
export type SupplyMode = "solar" | "battery" | "diesel" | "mixed";

export interface OpgPowerState {
  /** `global/telemetry/power` */
  totalGenerationKw?: number | null;
  totalLoadKw?: number | null;
  supplyMode?: SupplyMode | string;
  /** `solar/telemetry/power` */
  solarOutputKw?: number | null;
  irradianceWm2?: number | null;
  panelTemperatureC?: number | null;
  inverterStatus?: "online" | "offline" | "fault" | string;
  solarEnabled?: boolean;
  /** `batteries/telemetry/power` */
  batteryCapacityPct?: number | null;
  batteryOutputKw?: number | null;
  batteryTemperatureC?: number | null;
  batteryHealthPct?: number | null;
  batteryReservePct?: number | null;
  /** `diesel/telemetry/power` */
  dieselFuelPct?: number | null;
  dieselOutputKw?: number | null;
  generatorStatus?: string;
  dieselRuntimeH?: number | null;
  /** `global/state/*` */
  generationPriority?: GenerationPriority | string;
  loadShed?: boolean;
  updatedAt?: string;
}

export const OPG_BATTERY_CRITICAL_PCT = 30;
export const OPG_DIESEL_LOW_FUEL_PCT = 25;

// ---------------------------------------------------------------------------
// Command envelope published to `arl/<service>/cmd/<entity>/<control>`
// ---------------------------------------------------------------------------

export interface CommandEnvelope {
  command_id: string;
  researcher: string;
  value: unknown;
}

/** Ack published on `arl/<service>/ack/<command_id>`. */
export interface CommandAck {
  v?: number;
  ts?: number;
  command_id: string;
  target?: string;
  control?: string;
  researcher?: string;
  state: "accepted" | "in_progress" | "completed" | "rejected" | "failed" | string;
  progress?: number;
  reason?: string | null;
  detail?: string | null;
}

export type CommandOutcome = "completed" | "rejected" | "failed" | "timeout";

export interface CommandResult {
  commandId: string;
  topic: string;
  control: string;
  entity: string;
  value: unknown;
  outcome: CommandOutcome;
  ack: CommandAck | null;
  message: string;
}

// ---------------------------------------------------------------------------
// ARL REST API documents
// ---------------------------------------------------------------------------

/** `GET /v1/targets` — positions are radians. */
export interface ArlTarget {
  id: string;
  name: string;
  ra_rad: number;
  dec_rad: number;
  fov_rad: number;
  category: string;
}

/** `POST /v1/targets` */
export interface NewTarget {
  name: string;
  ra_rad: number;
  dec_rad: number;
  fov_rad: number;
  category: string;
}

export interface ArlResearcher {
  code: string;
  name: string;
  experiments: string[];
  status: string;
}

export interface ArlParameter {
  id?: string;
  name: string;
  value?: number | string | boolean;
  unit?: string;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// LWM — Local Weather Monitoring
// ---------------------------------------------------------------------------

/**
 * `arl/lwm/<site>/telemetry/weather` (wire shape).
 *
 * Five sites report once a minute. This is the lab's eye on the sky: the gust
 * figure is what puts the array into wind stow, and the irradiance figure is
 * what the power plant's solar prediction is built from.
 */
export interface LwmWeatherSample {
  temperature_k?: number | null;
  humidity_pct?: number | null;
  pressure_hpa?: number | null;
  wind_speed_ms?: number | null;
  wind_gust_ms?: number | null;
  wind_direction_rad?: number | null;
  irradiance_wm2?: number | null;
  rainfall_mm?: number | null;
  lightning_strikes?: number | null;
  battery_v?: number | null;
  status?: boolean | null;
}

/** `arl/lwm/lwm-3/telemetry/sonic` — turbulence-grade wind at the sonic site. */
export interface LwmSonicSample {
  wind_u_ms?: number | null;
  wind_v_ms?: number | null;
  wind_w_ms?: number | null;
  gust_factor?: number | null;
  turbulence_intensity?: number | null;
  direction_std_rad?: number | null;
  sonic_temperature_k?: number | null;
}

/** `arl/lwm/lwm-4/telemetry/soiling` — panel soiling ratio at the PV reference site. */
export interface LwmSoilingSample {
  exposed_irradiance_wm2?: number | null;
  reference_irradiance_wm2?: number | null;
  soiling_ratio?: number | null;
}

/** `arl/lwm/lwm-5/telemetry/pan` — evaporation pan, the water-budget site. */
export interface LwmPanSample {
  evaporation_mm?: number | null;
  pan_level_mm?: number | null;
}

/** `arl/lwm/global/telemetry/lightning` */
export interface LwmLightningSample {
  strikes_last_min?: number | null;
  nearest_strike_km?: number | null;
}

/** Gust at which the array stows, and the margin the weather console warns at. */
export const LWM_SOILING_WARN_RATIO = 0.9;
export const LWM_BATTERY_LOW_V = 11.8;
