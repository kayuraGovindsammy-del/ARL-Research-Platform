import { parseTopic } from "./topics";
import {
  MHE_CO2_LIMIT_PPM,
  MHE_CREW,
  MHE_HEART_RATE_LIMIT_BPM,
  MHE_ROOMS,
  MHE_SPO2_MIN_PCT,
  MHE_SURVEY_INTERVAL_MS,
  MHE_TELEMETRY_STALE_MS,
  MHE_VITALS_STALE_MS,
  kelvinToCelsius,
  type MheCrewHealth,
  type MheCrewSurvey,
  type MheHabitatTelemetry,
  type MheHydroponics,
  type MheLightingSchedule,
  type MheRoomId,
  type MheRoomTelemetry,
  type MheSetpoints,
  type MheSubsystems,
  type TopicState,
} from "./types";

/**
 * Pure derivations for the Mars Habitation Experiment dashboard.
 *
 * Room identity comes from the topic (`arl/mhe/<room>/telemetry/environment`),
 * because there is no per-service "status" document: the environment stream
 * carries the measurements, `state/setpoints` and `state/lighting_schedule`
 * carry the operator's intent, and the airlock/hydroponics rooms add a second
 * stream of their own.
 */

export interface RoomEntry {
  id: string;
  known: boolean;
  telemetry: MheRoomTelemetry | null;
  setpoints: MheSetpoints | null;
  lightingSchedule: MheLightingSchedule | null;
  sealed: boolean | null;
  environmentalSystems: boolean | null;
  hydroponics: MheHydroponics | null;
  timestamp: string | null;
}

export interface CrewEntry {
  id: string;
  name: string;
  health: MheCrewHealth | null;
  survey: MheCrewSurvey | null;
  healthAt: string | null;
  surveyAt: string | null;
}

export interface HabitatStatus {
  mode?: string;
  missionState?: string;
  online?: boolean;
  missionDay?: number;
  powerKw?: number;
  crewCount?: number;
  airlockState?: string;
  evaInProgress?: boolean;
  subsystems?: MheSubsystems;
  activeAlerts?: string[];
  updatedAt?: string;
}

export interface RoomSummary {
  roomsReporting: number;
  totalRoomCount: number;
  crewOnboard: number;
  averageTemperatureC: number | null;
  maxCo2Ppm: number | null;
  minO2Pct: number | null;
  staleRooms: number;
}

export interface CrewSummary {
  crewTracked: number;
  surveysRecent: number;
  maxHeartRate: number | null;
  alerts: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj<T>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

function stateEntry(
  topics: Record<string, TopicState>,
  entity: string,
  item: string,
): TopicState | null {
  const suffix = `/${entity}/state/${item}`;
  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service === "MHE" && parsed.kind === "state" && state.topic.endsWith(suffix)) {
      return state;
    }
  }
  return null;
}

function stateValueOf(topics: Record<string, TopicState>, entity: string, item: string): unknown {
  return stateEntry(topics, entity, item)?.payload.value;
}

export function getHabitatStatus(topics: Record<string, TopicState>): HabitatStatus | null {
  const telemetry = Object.values(topics).find((state) => {
    const parsed = parseTopic(state.topic);
    return parsed.service === "MHE" && parsed.entity === "global" && parsed.name === "habitat";
  });
  const missionState = stateValueOf(topics, "global", "mission_state");
  const online = bool(stateValueOf(topics, "global", "online"));
  const subsystems = obj<MheSubsystems>(stateValueOf(topics, "global", "subsystems"));
  const activeAlerts = stateValueOf(topics, "global", "active_alerts");

  const airlock = Object.values(topics).find((state) => {
    const parsed = parseTopic(state.topic);
    return parsed.service === "MHE" && parsed.entity === "airlock" && parsed.name === "airlock";
  });

  if (!telemetry && missionState === undefined && online === undefined) return null;

  const payload = (telemetry?.payload ?? {}) as unknown as MheHabitatTelemetry;
  const powerW = num(payload.power_w);

  return {
    mode: str(missionState) ?? undefined,
    missionState: str(missionState) ?? undefined,
    online,
    missionDay: num(payload.mission_day) ?? undefined,
    powerKw: powerW === null ? undefined : powerW / 1000,
    airlockState: str(airlock?.payload.airlock_state) ?? undefined,
    evaInProgress: bool(airlock?.payload.eva_in_progress),
    subsystems: subsystems ?? undefined,
    activeAlerts: Array.isArray(activeAlerts) ? activeAlerts.map(String) : [],
    updatedAt: telemetry?.timestamp,
  };
}

export function getRooms(topics: Record<string, TopicState>): RoomEntry[] {
  const map = new Map<string, RoomEntry>();

  const ensure = (id: string): RoomEntry => {
    const existing = map.get(id);
    if (existing) return existing;
    const created: RoomEntry = {
      id,
      known: true,
      telemetry: null,
      setpoints: null,
      lightingSchedule: null,
      sealed: null,
      environmentalSystems: null,
      hydroponics: null,
      timestamp: null,
    };
    map.set(id, created);
    return created;
  };

  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "MHE" || !parsed.entity) continue;
    const entity = parsed.entity;
    if (!(MHE_ROOMS as readonly string[]).includes(entity)) continue;

    if (parsed.kind === "telemetry" && parsed.name === "environment") {
      const entry = ensure(entity);
      const payload = state.payload;
      const oxygenPpm = num(payload.oxygen_ppm);
      const setpoints = obj<Record<string, unknown>>(stateValueOf(topics, entity, "setpoints"));
      entry.telemetry = {
        roomId: entity,
        temperatureC: kelvinToCelsius(num(payload.temperature_k)),
        humidityPct: num(payload.humidity_pct),
        oxygenPpm,
        o2Pct: oxygenPpm === null ? null : oxygenPpm / 10_000,
        co2Ppm: num(payload.co2_ppm),
        pressureKpa: num(payload.pressure_kpa),
        lightingLux: num(payload.lighting_lux),
        ventilationM3h: num(payload.ventilation_m3h),
        crewCount: num(payload.crew_count),
        updatedAt: state.timestamp,
      };
      if (setpoints) {
        entry.setpoints = {
          temperatureC: kelvinToCelsius(num(setpoints.temperature_k)),
          humidityPct: num(setpoints.humidity_pct),
          ventilationM3h: num(setpoints.ventilation_m3h),
        };
      }
      continue;
    }

    if (parsed.kind === "telemetry" && parsed.name === "airlock" && entity === "airlock") {
      const entry = ensure(entity);
      const airlockState = str(state.payload.airlock_state);
      entry.telemetry = {
        ...(entry.telemetry ?? { roomId: entity }),
        airlockState,
        pressurized: airlockState === "pressurised",
        innerDoor: str(state.payload.inner_door),
        outerDoor: str(state.payload.outer_door),
        evaInProgress: bool(state.payload.eva_in_progress),
        updatedAt: state.timestamp,
      };
      continue;
    }

    if (parsed.kind === "telemetry" && parsed.name === "hydroponics") {
      const entry = ensure(entity);
      entry.hydroponics = {
        waterLevelL: num(state.payload.water_level_l),
        waterPh: num(state.payload.water_ph),
        nutrientEcMscm: num(state.payload.nutrient_ec_mscm),
        growthStage: str(state.payload.growth_stage) ?? undefined,
        estimatedYieldKg: num(state.payload.estimated_yield_kg),
      };
      continue;
    }
  }

  for (const room of MHE_ROOMS) {
    const entry = ensure(room);
    const schedule = obj<Record<string, unknown>>(stateValueOf(topics, room, "lighting_schedule"));
    if (schedule) {
      entry.lightingSchedule = {
        start: str(schedule.start) ?? "00:00",
        end: str(schedule.end) ?? "00:00",
        levelLux: num(schedule.level_lux) ?? 0,
      };
    }
    entry.sealed = bool(stateValueOf(topics, room, "sealed")) ?? null;
    entry.environmentalSystems = bool(stateValueOf(topics, room, "environmental_systems")) ?? null;
  }

  return Array.from(map.values()).sort(
    (a, b) => MHE_ROOMS.indexOf(a.id as MheRoomId) - MHE_ROOMS.indexOf(b.id as MheRoomId),
  );
}

/** Parse `arl/mhe/events/survey` into the dashboard's survey model. */
export function parseSurveyEvent(
  payload: Record<string, unknown>,
  timestamp: string,
): MheCrewSurvey | null {
  const crewId = str(payload.entity);
  if (!crewId) return null;
  return {
    crewId,
    surveyType: str(payload.survey_type) ?? undefined,
    missionDay: num(payload.mission_day) ?? undefined,
    mood: num(payload.mood) ?? undefined,
    stress: num(payload.stress) ?? undefined,
    fatigue: num(payload.fatigue) ?? undefined,
    sleepQuality: num(payload.sleep_quality) ?? undefined,
    submittedAt: timestamp,
  };
}

/** Crew vitals from `telemetry/vitals`, optionally overlaid with surveys. */
export function getCrew(
  topics: Record<string, TopicState>,
  surveys: MheCrewSurvey[] = [],
): CrewEntry[] {
  const map = new Map<string, CrewEntry>();

  const ensure = (id: string): CrewEntry => {
    const existing = map.get(id);
    if (existing) return existing;
    const created: CrewEntry = {
      id,
      name: id,
      health: null,
      survey: null,
      healthAt: null,
      surveyAt: null,
    };
    map.set(id, created);
    return created;
  };

  for (const state of Object.values(topics)) {
    const parsed = parseTopic(state.topic);
    if (parsed.service !== "MHE" || parsed.kind !== "telemetry" || parsed.name !== "vitals") {
      continue;
    }
    const id = parsed.entity;
    if (!id) continue;
    const entry = ensure(id);
    entry.health = {
      crewId: id,
      heartRateBpm: num(state.payload.heart_rate_bpm),
      bodyTemperatureC: kelvinToCelsius(num(state.payload.body_temperature_k)),
      respiratoryRateBpm: num(state.payload.respiratory_rate_bpm),
      spo2Pct: num(state.payload.spo2_pct),
      movement: num(state.payload.movement),
      location: str(state.payload.location) ?? undefined,
      updatedAt: state.timestamp,
    };
    entry.healthAt = state.timestamp;
  }

  for (const survey of surveys) {
    const entry = ensure(survey.crewId);
    if (!entry.survey || (survey.submittedAt ?? "") >= (entry.surveyAt ?? "")) {
      entry.survey = survey;
      entry.surveyAt = survey.submittedAt ?? null;
    }
  }

  for (const id of MHE_CREW) ensure(id);

  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function summarizeRooms(rooms: RoomEntry[], now = Date.now()): RoomSummary {
  let reporting = 0;
  let crewOnboard = 0;
  let temperatureSum = 0;
  let temperatureCount = 0;
  let maxCo2: number | null = null;
  let minO2: number | null = null;
  let stale = 0;

  for (const room of rooms) {
    if (!room.telemetry) continue;
    // The airlock stream is merged onto the room but is not an environment
    // sample; only count rooms that reported an environment payload.
    if (typeof room.telemetry.temperatureC !== "number") continue;
    reporting += 1;
    crewOnboard += num(room.telemetry.crewCount) ?? 0;

    const temperature = num(room.telemetry.temperatureC);
    if (temperature !== null) {
      temperatureSum += temperature;
      temperatureCount += 1;
    }

    const co2 = num(room.telemetry.co2Ppm);
    if (co2 !== null && (maxCo2 === null || co2 > maxCo2)) maxCo2 = co2;

    const o2 = num(room.telemetry.o2Pct);
    if (o2 !== null && (minO2 === null || o2 < minO2)) minO2 = o2;

    if (room.timestamp && now - Date.parse(room.timestamp) > MHE_TELEMETRY_STALE_MS) {
      stale += 1;
    }
  }

  return {
    roomsReporting: reporting,
    totalRoomCount: rooms.length,
    crewOnboard,
    averageTemperatureC: temperatureCount > 0 ? temperatureSum / temperatureCount : null,
    maxCo2Ppm: maxCo2,
    minO2Pct: minO2,
    staleRooms: stale,
  };
}

export function summarizeCrew(crew: CrewEntry[], now = Date.now()): CrewSummary {
  let surveysRecent = 0;
  let maxHeartRate: number | null = null;
  let alerts = 0;

  for (const member of crew) {
    if (member.surveyAt && now - Date.parse(member.surveyAt) <= MHE_SURVEY_INTERVAL_MS) {
      surveysRecent += 1;
    }
    const heartRate = num(member.health?.heartRateBpm);
    if (heartRate !== null) {
      if (maxHeartRate === null || heartRate > maxHeartRate) maxHeartRate = heartRate;
      if (heartRate >= MHE_HEART_RATE_LIMIT_BPM) alerts += 1;
    }
    const spo2 = num(member.health?.spo2Pct);
    if (spo2 !== null && spo2 < MHE_SPO2_MIN_PCT) alerts += 1;
  }

  return {
    crewTracked: crew.filter((member) => member.health !== null).length,
    surveysRecent,
    maxHeartRate,
    alerts,
  };
}

export interface DerivedAlert {
  tone: "warn" | "alert";
  message: string;
}

export function deriveMheAlerts(
  rooms: RoomEntry[],
  crew: CrewEntry[],
  now = Date.now(),
): DerivedAlert[] {
  const alerts: DerivedAlert[] = [];

  for (const room of rooms) {
    const co2 = num(room.telemetry?.co2Ppm);
    if (co2 !== null && co2 >= MHE_CO2_LIMIT_PPM) {
      alerts.push({
        tone: "alert",
        message: `${room.id}: CO₂ ${Math.round(co2)} ppm exceeds ${MHE_CO2_LIMIT_PPM} ppm.`,
      });
    }
    if (
      room.telemetry &&
      typeof room.telemetry.temperatureC === "number" &&
      room.timestamp &&
      now - Date.parse(room.timestamp) > MHE_TELEMETRY_STALE_MS
    ) {
      alerts.push({
        tone: "warn",
        message: `${room.id}: telemetry older than ${Math.round(MHE_TELEMETRY_STALE_MS / 60000)} min.`,
      });
    }
    if (room.id === "airlock") {
      if (room.telemetry?.airlockState === "depressurised") {
        alerts.push({ tone: "warn", message: "Airlock is depressurised." });
      } else if (room.telemetry?.airlockState === "cycling") {
        alerts.push({ tone: "warn", message: "Airlock is cycling." });
      }
    }
  }

  for (const member of crew) {
    const heartRate = num(member.health?.heartRateBpm);
    if (heartRate !== null && heartRate >= MHE_HEART_RATE_LIMIT_BPM) {
      alerts.push({
        tone: "alert",
        message: `${member.name}: heart rate ${Math.round(heartRate)} bpm ≥ ${MHE_HEART_RATE_LIMIT_BPM} bpm.`,
      });
    }
    const spo2 = num(member.health?.spo2Pct);
    if (spo2 !== null && spo2 < MHE_SPO2_MIN_PCT) {
      alerts.push({
        tone: "alert",
        message: `${member.name}: SpO₂ ${spo2.toFixed(1)} % below ${MHE_SPO2_MIN_PCT} %.`,
      });
    }
    if (member.surveyAt && now - Date.parse(member.surveyAt) > MHE_SURVEY_INTERVAL_MS) {
      alerts.push({ tone: "warn", message: `${member.name}: crew survey overdue.` });
    }
    // "Crew member's data disappears": vitals are published every minute, so a
    // member whose stream has gone quiet is a health signal in itself, not just
    // a gap on the dashboard.
    if (member.healthAt && now - Date.parse(member.healthAt) > MHE_VITALS_STALE_MS) {
      const silentMinutes = Math.round((now - Date.parse(member.healthAt)) / 60000);
      alerts.push({
        tone: "alert",
        message: `${member.name}: vitals silent for ${silentMinutes} min (expected every minute).`,
      });
    }
  }

  return alerts;
}
