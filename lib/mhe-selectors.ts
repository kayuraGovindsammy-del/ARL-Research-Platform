import {
  MHE_CO2_LIMIT_PPM,
  MHE_CREW,
  MHE_HEART_RATE_LIMIT_BPM,
  MHE_ROOMS,
  MHE_SURVEY_INTERVAL_MS,
  MHE_TELEMETRY_STALE_MS,
  type MheCrewHealth,
  type MheCrewSurvey,
  type MheRoomId,
  type MheRoomTelemetry,
  type TopicState,
} from "./types";

/** Pure derivations for the Mars Habitation Experiment dashboard. */

export interface RoomEntry {
  id: string;
  known: boolean;
  telemetry: MheRoomTelemetry | null;
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
  airlockState?: string;
  lightLevelPct?: number;
  missionDay?: number;
  crewCount?: number;
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

function idFromTopic(topic: string, marker: string): string | null {
  const segments = topic.split("/");
  const index = segments.indexOf(marker);
  if (index === -1 || index + 1 >= segments.length) return null;
  return segments[index + 1] || null;
}

export function getHabitatStatus(topics: Record<string, TopicState>): HabitatStatus | null {
  const entry = Object.values(topics).find((state) => state.topic.endsWith("/mhe/habitat/status"));
  if (!entry) return null;
  return entry.payload as unknown as HabitatStatus;
}

export function getRooms(topics: Record<string, TopicState>): RoomEntry[] {
  const map = new Map<string, RoomEntry>();

  for (const state of Object.values(topics)) {
    if (!/\/mhe\/room\/[^/]+\/telemetry$/.test(state.topic)) continue;
    const id = idFromTopic(state.topic, "room");
    if (!id) continue;
    map.set(id, {
      id,
      known: true,
      telemetry: state.payload as unknown as MheRoomTelemetry,
      timestamp: state.timestamp,
    });
  }

  const ordered: RoomEntry[] = MHE_ROOMS.map(
    (roomId: MheRoomId) =>
      map.get(roomId) ?? { id: roomId, known: false, telemetry: null, timestamp: null },
  );

  for (const [id, room] of map) {
    if (!MHE_ROOMS.includes(id as MheRoomId)) ordered.push(room);
  }

  return ordered;
}

export function getCrew(topics: Record<string, TopicState>): CrewEntry[] {
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
    if (/\/mhe\/crew\/[^/]+\/health$/.test(state.topic)) {
      const id = idFromTopic(state.topic, "crew");
      if (!id) continue;
      const entry = ensure(id);
      const payload = state.payload as unknown as MheCrewHealth;
      entry.health = payload;
      entry.healthAt = state.timestamp;
      entry.name = payload.name ?? entry.name;
    } else if (/\/mhe\/crew\/[^/]+\/survey$/.test(state.topic)) {
      const id = idFromTopic(state.topic, "crew");
      if (!id) continue;
      const entry = ensure(id);
      entry.survey = state.payload as unknown as MheCrewSurvey;
      entry.surveyAt = state.timestamp;
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
    if (room.timestamp && now - Date.parse(room.timestamp) > MHE_TELEMETRY_STALE_MS) {
      alerts.push({
        tone: "warn",
        message: `${room.id}: telemetry older than ${Math.round(MHE_TELEMETRY_STALE_MS / 60000)} min.`,
      });
    }
    if (
      room.id === "airlock" &&
      (room.telemetry?.pressurized === false || room.telemetry?.airlockState === "DEPRESSURIZED")
    ) {
      alerts.push({ tone: "warn", message: "Airlock is depressurized." });
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
    if (member.surveyAt && now - Date.parse(member.surveyAt) > MHE_SURVEY_INTERVAL_MS) {
      alerts.push({ tone: "warn", message: `${member.name}: crew survey overdue.` });
    }
  }

  return alerts;
}
