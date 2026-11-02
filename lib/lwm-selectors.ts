import { parseTopic } from "./topics";
import {
  kelvinToCelsius,
  radiansToDegrees,
  LWM_BATTERY_LOW_V,
  LWM_SOILING_WARN_RATIO,
  RTA_WIND_STOW_LIMIT_MS,
  type LwmLightningSample,
  type LwmPanSample,
  type LwmSoilingSample,
  type LwmSonicSample,
  type LwmWeatherSample,
  type TopicState,
} from "./types";

/**
 * Pure derivations from the topic map for the Local Weather Monitoring service.
 *
 * LWM is the lab's context service: five sites publish weather once a minute
 * from fixed positions, and three of them carry a specialist instrument — a
 * sonic anemometer, a soiled-vs-clean irradiance pair and an evaporation pan.
 * None of that is worth a number on a page on its own; it is worth something
 * when it explains another service. A gust above the stow limit explains why
 * the array stopped scanning, and a soiling ratio below 0.9 explains why the
 * solar plant is producing less than the irradiance says it should.
 */

export interface WeatherReading {
  temperatureC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  /** Compass bearing, 0° = north. */
  windDirectionDeg: number | null;
  irradianceWm2: number | null;
  rainfallMm: number | null;
  lightningStrikes: number | null;
  batteryV: number | null;
  status: boolean | null;
}

export interface WeatherSite {
  id: string;
  weather: WeatherReading | null;
  position: { lat: number; lon: number } | null;
  enabled: boolean | null;
  sampleIntervalS: number | null;
  lastCalibrationAt: number | null;
  sonic: LwmSonicSample | null;
  soiling: LwmSoilingSample | null;
  pan: LwmPanSample | null;
  timestamp: string | null;
}

export interface WeatherSummary {
  sitesReporting: number;
  totalSites: number;
  meanTemperatureC: number | null;
  meanHumidityPct: number | null;
  meanPressureHpa: number | null;
  meanWindMs: number | null;
  maxWindMs: number | null;
  maxGustMs: number | null;
  maxGustSite: string | null;
  /** Headroom left before the array stows, in m/s (negative once past it). */
  stowMarginMs: number | null;
  meanIrradianceWm2: number | null;
  maxIrradianceWm2: number | null;
  totalRainfallMm: number | null;
  totalLightningStrikes: number | null;
  /** Lowest soiling ratio reported (1.0 = clean reference). */
  minSoilingRatio: number | null;
  soilingSite: string | null;
  panLevelMm: number | null;
  evaporationMm: number | null;
  meanBatteryV: number | null;
  gustFactor: number | null;
  turbulenceIntensity: number | null;
  staleSites: number;
}

export interface DerivedWeatherAlert {
  tone: "warn" | "alert";
  message: string;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** Latest retained state for one site, or `null` when it never reported it. */
function siteState(topics: Record<string, TopicState>, site: string, item: string): unknown {
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "LWM" || parsed.entity !== site) continue;
    if (parsed.kind === "state" && parsed.name === item) return state.payload.value;
  }
  return null;
}

function toReading(payload: Record<string, unknown>): WeatherReading {
  const temperatureK = num(payload.temperature_k);
  const directionRad = num(payload.wind_direction_rad);
  return {
    temperatureC: temperatureK === null ? null : kelvinToCelsius(temperatureK),
    humidityPct: num(payload.humidity_pct),
    pressureHpa: num(payload.pressure_hpa),
    windSpeedMs: num(payload.wind_speed_ms),
    windGustMs: num(payload.wind_gust_ms),
    windDirectionDeg:
      directionRad === null ? null : (((radiansToDegrees(directionRad) ?? 0) % 360) + 360) % 360,
    irradianceWm2: num(payload.irradiance_wm2),
    rainfallMm: num(payload.rainfall_mm),
    lightningStrikes: num(payload.lightning_strikes),
    batteryV: num(payload.battery_v),
    status: bool(payload.status),
  };
}

export function getWeatherSites(topics: Record<string, TopicState>): WeatherSite[] {
  const map = new Map<string, WeatherSite>();

  const ensure = (id: string): WeatherSite => {
    const existing = map.get(id);
    if (existing) return existing;
    const created: WeatherSite = {
      id,
      weather: null,
      position: null,
      enabled: null,
      sampleIntervalS: null,
      lastCalibrationAt: null,
      sonic: null,
      soiling: null,
      pan: null,
      timestamp: null,
    };
    map.set(id, created);
    return created;
  };

  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "LWM" || !parsed.entity || parsed.entity === "global") continue;
    const site = ensure(parsed.entity);

    if (parsed.kind === "telemetry" && parsed.name === "weather") {
      site.weather = toReading(state.payload);
      site.timestamp = state.timestamp;
      continue;
    }
    if (parsed.kind === "telemetry" && parsed.name === "sonic") {
      site.sonic = state.payload as unknown as LwmSonicSample;
      continue;
    }
    if (parsed.kind === "telemetry" && parsed.name === "soiling") {
      site.soiling = state.payload as unknown as LwmSoilingSample;
      continue;
    }
    if (parsed.kind === "telemetry" && parsed.name === "pan") {
      site.pan = state.payload as unknown as LwmPanSample;
      continue;
    }
    if (parsed.kind === "state") {
      const value = state.payload.value;
      if (parsed.name === "enabled") site.enabled = bool(value);
      else if (parsed.name === "sample_interval_s") site.sampleIntervalS = num(value);
      else if (parsed.name === "last_calibration") site.lastCalibrationAt = num(value);
      else if (parsed.name === "position" && value && typeof value === "object") {
        const position = value as { lat?: unknown; lon?: unknown };
        const lat = num(position.lat);
        const lon = num(position.lon);
        if (lat !== null && lon !== null) site.position = { lat, lon };
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** `arl/lwm/global/telemetry/lightning` — the platform-wide strike counter. */
export function getLightning(topics: Record<string, TopicState>): LwmLightningSample | null {
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (
      parsed.service === "LWM" &&
      parsed.kind === "telemetry" &&
      parsed.entity === "global" &&
      parsed.name === "lightning"
    ) {
      return state.payload as unknown as LwmLightningSample;
    }
  }
  return null;
}

export function summarizeWeather(sites: WeatherSite[], now = Date.now()): WeatherSummary {
  const live = sites.filter((site) => site.weather !== null);
  const readings = live.map((site) => site.weather!).filter(Boolean);

  const temperatures = readings.map((reading) => reading.temperatureC).filter((value): value is number => value !== null);
  const humidities = readings.map((reading) => reading.humidityPct).filter((value): value is number => value !== null);
  const pressures = readings.map((reading) => reading.pressureHpa).filter((value): value is number => value !== null);
  const winds = readings.map((reading) => reading.windSpeedMs).filter((value): value is number => value !== null);
  const gusts = readings.map((reading) => reading.windGustMs).filter((value): value is number => value !== null);
  const irradiances = readings.map((reading) => reading.irradianceWm2).filter((value): value is number => value !== null);
  const rainfall = readings.map((reading) => reading.rainfallMm).filter((value): value is number => value !== null);
  const lightning = readings
    .map((reading) => reading.lightningStrikes)
    .filter((value): value is number => value !== null);
  const batteries = readings.map((reading) => reading.batteryV).filter((value): value is number => value !== null);

  let maxGustMs: number | null = null;
  let maxGustSite: string | null = null;
  for (const site of live) {
    const gust = site.weather?.windGustMs ?? null;
    if (gust === null) continue;
    if (maxGustMs === null || gust > maxGustMs) {
      maxGustMs = gust;
      maxGustSite = site.id;
    }
  }

  let minSoilingRatio: number | null = null;
  let soilingSite: string | null = null;
  for (const site of sites) {
    const ratio = num(site.soiling?.soiling_ratio);
    if (ratio === null) continue;
    if (minSoilingRatio === null || ratio < minSoilingRatio) {
      minSoilingRatio = ratio;
      soilingSite = site.id;
    }
  }

  const pan = sites.find((site) => site.pan !== null)?.pan ?? null;
  const sonic = sites.find((site) => site.sonic !== null)?.sonic ?? null;

  const staleSites = live.filter(
    (site) => site.timestamp !== null && now - Date.parse(site.timestamp) > 5 * 60_000,
  ).length;

  return {
    sitesReporting: live.length,
    totalSites: Math.max(sites.length, live.length),
    meanTemperatureC: mean(temperatures),
    meanHumidityPct: mean(humidities),
    meanPressureHpa: mean(pressures),
    meanWindMs: mean(winds),
    maxWindMs: max(winds),
    maxGustMs,
    maxGustSite,
    stowMarginMs: maxGustMs === null ? null : RTA_WIND_STOW_LIMIT_MS - maxGustMs,
    meanIrradianceWm2: mean(irradiances),
    maxIrradianceWm2: max(irradiances),
    totalRainfallMm: rainfall.length === 0 ? null : rainfall.reduce((total, value) => total + value, 0),
    totalLightningStrikes:
      lightning.length === 0 ? null : lightning.reduce((total, value) => total + value, 0),
    minSoilingRatio,
    soilingSite,
    panLevelMm: num(pan?.pan_level_mm),
    evaporationMm: num(pan?.evaporation_mm),
    meanBatteryV: mean(batteries),
    gustFactor: num(sonic?.gust_factor),
    turbulenceIntensity: num(sonic?.turbulence_intensity),
    staleSites,
  };
}

/**
 * Conditions worth telling the operator about, in the same shape the service
 * consoles use for their banner. They are phrased in terms of what the weather
 * does to the other services, because that is the decision being made.
 */
export function deriveWeatherAlerts(
  sites: WeatherSite[],
  summary: WeatherSummary,
  now = Date.now(),
): DerivedWeatherAlert[] {
  const alerts: DerivedWeatherAlert[] = [];

  if (summary.maxGustMs !== null) {
    if (summary.maxGustMs >= RTA_WIND_STOW_LIMIT_MS) {
      alerts.push({
        tone: "alert",
        message: `Gust ${summary.maxGustMs.toFixed(1)} m/s at ${summary.maxGustSite} ≥ ${RTA_WIND_STOW_LIMIT_MS} m/s — the array stows in this wind.`,
      });
    } else if (summary.maxGustMs >= RTA_WIND_STOW_LIMIT_MS * 0.8) {
      alerts.push({
        tone: "warn",
        message: `Gust ${summary.maxGustMs.toFixed(1)} m/s at ${summary.maxGustSite} is within 20 % of the ${RTA_WIND_STOW_LIMIT_MS} m/s stow limit.`,
      });
    }
  }

  if (summary.minSoilingRatio !== null && summary.minSoilingRatio < LWM_SOILING_WARN_RATIO) {
    alerts.push({
      tone: "warn",
      message: `Soiling ratio ${summary.minSoilingRatio.toFixed(3)} at ${summary.soilingSite} — clean the reference panels before trusting the solar yield.`,
    });
  }

  for (const site of sites) {
    const battery = site.weather?.batteryV ?? null;
    if (battery !== null && battery < LWM_BATTERY_LOW_V) {
      alerts.push({
        tone: "warn",
        message: `${site.id}: station battery ${battery.toFixed(1)} V below ${LWM_BATTERY_LOW_V} V.`,
      });
    }
    if (site.weather?.status === false) {
      alerts.push({ tone: "warn", message: `${site.id}: station reports itself unhealthy.` });
    }
    if (site.enabled === false) {
      alerts.push({ tone: "warn", message: `${site.id}: station disabled — no wind context for the array.` });
    }
    if (site.timestamp && now - Date.parse(site.timestamp) > 5 * 60_000) {
      alerts.push({ tone: "warn", message: `${site.id}: no weather sample for over 5 minutes.` });
    }
  }

  return alerts;
}
