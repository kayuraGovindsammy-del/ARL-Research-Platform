import mqtt from "mqtt";
import { loadConfig } from "./env.mjs";

/**
 * ARL telemetry simulator.
 *
 * Publishes a realistic message mix on the same topic contract the platform
 * ingests (see lib/topics.ts) and reacts to operator commands from
 * `arl/<service>/cmd/<action>`, so the whole control loop can be exercised
 * locally:
 *
 *   arl/rta/array/status, arl/rta/dish/<id>/metrics, arl/rta/scan/<id>/sample
 *   arl/mhe/habitat/status, arl/mhe/room/<id>/telemetry,
 *   arl/mhe/crew/<id>/health, arl/mhe/crew/<id>/survey
 *   arl/opg/power, arl/opg/source/<name>/status
 *
 * Cadences follow the spec (dish metrics 2 min, room telemetry 5 min, crew
 * vitals 1 min, scan samples 1 Hz). The mission day is compressed so surveys
 * appear during a short demo. Every scenario toggle set can be disabled with
 * SIM_SCENARIOS=0.
 */

const config = loadConfig();
const prefix = config.topicPrefix;
const brokerUrl = `${config.brokerProtocol}://${config.brokerAddress}:${config.brokerPort}`;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const CADENCE = {
  dishMetricsMs: envNumber("SIM_DISH_METRICS_MS", 120_000),
  roomTelemetryMs: envNumber("SIM_ROOM_TELEMETRY_MS", 300_000),
  crewHealthMs: envNumber("SIM_CREW_HEALTH_MS", 60_000),
  habitatMs: 60_000,
  powerMs: envNumber("SIM_POWER_MS", 5_000),
  sourceStatusMs: 30_000,
  scanTickMs: 1_000,
  /** Compressed mission day: a real habitation day is 24 h. */
  missionDayMs: envNumber("SIM_MISSION_DAY_MS", 10 * 60_000),
};

const SCENARIOS = process.env.SIM_SCENARIOS !== "0";

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digits = 1) => Number(value.toFixed(digits));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// RTA state
// ---------------------------------------------------------------------------
const DISH_IDS = Array.from({ length: 100 }, (_, index) => `D-${String(index + 1).padStart(3, "0")}`);

const dishes = new Map(
  DISH_IDS.map((id) => [
    id,
    {
      id,
      subArray: "main",
      condition: "OPERATIONAL",
      temperatureC: rand(30, 38),
      powerW: rand(380, 470),
      azimuthDeg: rand(0, 360),
      elevationDeg: rand(35, 55),
      heatBoost: 0,
    },
  ]),
);

const array = {
  status: "IDLE",
  scanId: null,
  targetId: null,
  targetName: null,
  windSpeedMs: rand(5, 9),
  startedAt: null,
  scanIndex: 0,
  stowAfterGust: false,
};

function operationalDishCount() {
  let count = 0;
  for (const dish of dishes.values()) {
    if (dish.condition === "OPERATIONAL" || dish.condition === "DEGRADED") count += 1;
  }
  return count;
}

function subArrayMap() {
  const map = new Map();
  for (const dish of dishes.values()) {
    const entry = map.get(dish.subArray) ?? { dishIds: [], label: titleCase(dish.subArray) };
    entry.dishIds.push(dish.id);
    map.set(dish.subArray, entry);
  }
  return Object.fromEntries(map);
}

function titleCase(value) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function arrayStatusPayload() {
  return {
    status: array.status,
    scanId: array.scanId,
    targetId: array.targetId,
    targetName: array.targetName,
    windSpeedMs: round(array.windSpeedMs, 1),
    operationalDishes: operationalDishCount(),
    subArrays: subArrayMap(),
    startedAt: array.startedAt,
    updatedAt: nowIso(),
  };
}

function dishPayload(dish) {
  return {
    dishId: dish.id,
    subArray: dish.subArray,
    condition: dish.condition,
    temperatureC: round(dish.temperatureC, 1),
    powerW: round(dish.powerW, 0),
    azimuthDeg: round(dish.azimuthDeg, 2),
    elevationDeg: round(dish.elevationDeg, 2),
    targetId: array.targetId,
    updatedAt: nowIso(),
  };
}

function driftDishes() {
  const scanning = array.status === "SCANNING";

  for (const dish of dishes.values()) {
    // Ambient drift, plus the injected heat scenario decaying back to normal.
    dish.temperatureC += rand(-0.8, 0.9) + (dish.heatBoost > 0 ? 0.9 : 0);
    dish.heatBoost = Math.max(0, dish.heatBoost - 1.5);
    dish.temperatureC = clamp(dish.temperatureC, 18, 92);

    if (dish.condition === "DISABLED" || dish.condition === "OFFLINE") {
      dish.powerW = clamp(dish.powerW + rand(-4, 4), 0, 40);
      continue;
    }

    dish.powerW = clamp(dish.powerW + rand(-12, 12), 320, 520);
    if (scanning) {
      // Track the target with a small per-dish pointing error.
      dish.azimuthDeg = (dish.azimuthDeg + rand(-0.35, 0.35) + 360) % 360;
      dish.elevationDeg = clamp(dish.elevationDeg + rand(-0.2, 0.2), 5, 88);
    } else {
      dish.azimuthDeg = (dish.azimuthDeg + rand(-0.05, 0.05) + 360) % 360;
    }

    if (dish.condition === "DEGRADED" && Math.random() < 0.04) dish.condition = "OPERATIONAL";
  }
}

function publishAllDishes() {
  for (const dish of dishes.values()) {
    publish(`rta/dish/${dish.id}/metrics`, dishPayload(dish));
  }
  publishState("rta/array/status", arrayStatusPayload());
}

/**
 * Scan geometry. Each tick publishes one dish-offset row across the whole
 * frequency band (a raster sweep), so the composite map fills in 2 dimensions
 * instead of tracing a single correlated path. 36 rows × 24 channels fits
 * inside the client's 900-sample buffer.
 */
const SCAN = {
  freqMinMhz: 1216,
  freqMaxMhz: 1629,
  steps: 24,
  rows: 36,
  offsetMaxDeg: 0.68,
};

function sampleValue(offsetDeg, frequencyMhz) {
  // Spectral line strengths, attenuated by the beam pattern as the dish
  // offset grows: bright columns fall off to the right of the map.
  const line = (freq, amplitude, widthMhz) =>
    amplitude * Math.exp(-((frequencyMhz - freq) ** 2) / (2 * widthMhz ** 2));
  const beamFalloff = Math.exp(-((offsetDeg / 0.34) ** 2));
  const bandFloor = 0.45 + 0.25 * Math.sin(frequencyMhz / 40) ** 2;

  const primary = line(1419, 8.2, 13);
  const secondary = line(1560, 4.4, 9);
  return round((bandFloor + primary + secondary) * beamFalloff + Math.random() * 0.35, 3);
}

function publishScanTick() {
  if (array.status !== "SCANNING" || !array.scanId) return;

  // One row per tick: fixed dish offset, full frequency sweep.
  const row = array.scanIndex % SCAN.rows;
  array.scanIndex += 1;
  const offsetAzDeg = round((row / (SCAN.rows - 1)) * SCAN.offsetMaxDeg, 4);
  const offsetElDeg = 0;

  for (let step = 0; step < SCAN.steps; step += 1) {
    const frequencyMhz = round(
      SCAN.freqMinMhz + ((SCAN.freqMaxMhz - SCAN.freqMinMhz) * step) / (SCAN.steps - 1),
      2,
    );

    publish(`rta/scan/${array.scanId}/sample`, {
      scanId: array.scanId,
      sampleIndex: array.scanIndex,
      frequencyMhz,
      offsetAzDeg,
      offsetElDeg,
      value: sampleValue(offsetAzDeg, frequencyMhz),
      dishId: pick(DISH_IDS),
    });
  }
}

function startScan(targetId, params) {
  array.status = "SCANNING";
  array.scanId = `scan-${Date.now().toString(36)}`;
  array.targetId = targetId;
  array.targetName = params.custom ? `Custom ${targetId}` : titleCase(String(targetId).replace(/^tgt-/, "Target "));
  array.startedAt = nowIso();
  array.scanIndex = 0;
  publishState("rta/array/status", arrayStatusPayload());
}

function stowArray(reason) {
  array.status = "STOWED";
  array.scanId = null;
  for (const dish of dishes.values()) {
    if (dish.condition === "OPERATIONAL" || dish.condition === "DEGRADED") dish.condition = "STOWED";
    dish.elevationDeg = 90;
  }
  console.log(`[sim] array stowed (${reason})`);
  publishState("rta/array/status", arrayStatusPayload());
}

function unstowArray() {
  for (const dish of dishes.values()) {
    if (dish.condition === "STOWED") dish.condition = "OPERATIONAL";
    dish.elevationDeg = rand(35, 55);
  }
  array.status = "IDLE";
  publishState("rta/array/status", arrayStatusPayload());
}

// ---------------------------------------------------------------------------
// MHE state
// ---------------------------------------------------------------------------
const ROOM_IDS = [
  "quarters-1",
  "quarters-2",
  "quarters-3",
  "quarters-4",
  "quarters-5",
  "common",
  "lab",
  "hydroponics",
  "airlock",
];

const rooms = new Map(
  ROOM_IDS.map((roomId) => {
    const personal = roomId.startsWith("quarters");
    const crewInRoom = personal ? 1 : roomId === "common" ? 2 : roomId === "lab" ? 1 : 0;
    return [
      roomId,
      {
        roomId,
        setpointC: personal ? 21.5 : 22.5,
        temperatureC: personal ? 21.5 : 22.5,
        crewCount: crewInRoom,
        o2Pct: 20.9,
        co2Ppm: personal ? rand(520, 700) : rand(640, 900),
        pressurized: true,
        airlockState: roomId === "airlock" ? "PRESSURIZED" : null,
        lightLevelPct: roomId === "hydroponics" ? 82 : personal ? 45 : 70,
        co2Boost: 0,
      },
    ];
  }),
);

const habitat = {
  mode: "NOMINAL",
  missionDay: 1,
  lightLevelPct: 70,
};

const CREW = [
  { id: "crew-1", name: "Cmdr. A. Okafor" },
  { id: "crew-2", name: "Dr. J. Lindqvist" },
  { id: "crew-3", name: "Dr. M. Haddad" },
  { id: "crew-4", name: "Eng. R. Vasquez" },
  { id: "crew-5", name: "Dr. S. Nakamura" },
];

const crew = new Map(
  CREW.map((member) => [
    member.id,
    {
      ...member,
      heartRateBpm: rand(62, 82),
      bodyTempC: rand(36.4, 37.1),
      heartBoost: 0,
      lastSurveyMissionDay: 0,
    },
  ]),
);

function roomPayload(room) {
  return {
    roomId: room.roomId,
    temperatureC: round(room.temperatureC, 2),
    crewCount: room.crewCount,
    o2Pct: round(room.o2Pct, 2),
    co2Ppm: Math.round(room.co2Ppm),
    pressurized: room.pressurized,
    ...(room.airlockState ? { airlockState: room.airlockState } : {}),
    lightLevelPct: Math.round(room.lightLevelPct),
    updatedAt: nowIso(),
  };
}

function habitatPayload() {
  return {
    mode: habitat.mode,
    missionDay: habitat.missionDay,
    lightLevelPct: Math.round(habitat.lightLevelPct),
    crewCount: CREW.length,
    airlockState: rooms.get("airlock").airlockState,
    updatedAt: nowIso(),
  };
}

function publishAllRooms() {
  for (const room of rooms.values()) publishState(`mhe/room/${room.roomId}/telemetry`, roomPayload(room));
  publishState("mhe/habitat/status", habitatPayload());
}

function driftRooms() {
  for (const room of rooms.values()) {
    // O2 is essentially stable; CO2 responds to occupancy and scrubbing.
    room.o2Pct = clamp(room.o2Pct + rand(-0.04, 0.04), 19.6, 21.2);
    const production = room.crewCount * rand(8, 16);
    const scrubbed = room.co2Ppm * 0.02;
    room.co2Ppm = clamp(room.co2Ppm + production + room.co2Boost - scrubbed, 380, 9000);
    room.co2Boost = Math.max(0, room.co2Boost - 22);

    const pull = (room.setpointC - room.temperatureC) * 0.18;
    room.temperatureC = clamp(room.temperatureC + pull + rand(-0.22, 0.22), 12, 38);
  }
}

function crewPayload(member) {
  return {
    crewId: member.id,
    name: member.name,
    heartRateBpm: Math.round(member.heartRateBpm),
    bodyTempC: round(member.bodyTempC, 2),
    updatedAt: nowIso(),
  };
}

function publishAllCrew() {
  for (const member of crew.values()) publishState(`mhe/crew/${member.id}/health`, crewPayload(member));
}

function driftCrew() {
  for (const member of crew.values()) {
    const baseline = 72;
    member.heartRateBpm = clamp(
      member.heartRateBpm + (baseline - member.heartRateBpm) * 0.2 + rand(-3.5, 3.5) + member.heartBoost,
      48,
      168,
    );
    member.heartBoost = Math.max(0, member.heartBoost - 2.2);
    member.bodyTempC = clamp(member.bodyTempC + rand(-0.04, 0.04), 36, 39);
  }
}

function surveyPayload(member) {
  return {
    crewId: member.id,
    missionDay: habitat.missionDay,
    mood: Math.round(clamp(rand(5, 10) - Math.max(0, member.heartBoost) / 20, 1, 10)),
    stress: Math.round(clamp(rand(1, 6) + (100 - member.heartRateBpm) / 90, 1, 10)),
    fatigue: Math.round(clamp(rand(2, 7), 1, 10)),
    sleepQuality: Math.round(clamp(rand(4, 10), 1, 10)),
    submittedAt: nowIso(),
  };
}

function submitSurveys() {
  for (const member of crew.values()) {
    member.lastSurveyMissionDay = habitat.missionDay;
    publish(`mhe/crew/${member.id}/survey`, surveyPayload(member));
  }
  console.log(`[sim] crew surveys submitted for mission day ${habitat.missionDay}`);
}

// ---------------------------------------------------------------------------
// OPG state
// ---------------------------------------------------------------------------
const opg = {
  solarCapacityKw: 420,
  solarOutputKw: 300,
  solarEnabled: true,
  inverterStatus: "ONLINE",
  batteryCapacityPct: 76,
  batteryOutputKw: 0,
  dieselOutputKw: 0,
  dieselRunning: false,
  dieselFuelPct: 68,
  demandKw: 300,
  activeSource: "SOLAR",
  loadShedding: false,
  shedLoadKw: 0,
  cloudFactor: 1,
  solarDropTicks: 0,
};

function powerPayload() {
  const solar = opg.solarEnabled ? opg.solarOutputKw : 0;
  const diesel = opg.dieselRunning ? opg.dieselOutputKw : 0;
  return {
    solarOutputKw: round(solar, 1),
    solarCapacityKw: opg.solarCapacityKw,
    solarEnabled: opg.solarEnabled,
    inverterStatus: opg.solarEnabled ? opg.inverterStatus : "STANDBY",
    batteryCapacityPct: round(opg.batteryCapacityPct, 1),
    // Positive while discharging, negative while charging from surplus solar.
    batteryOutputKw: round(opg.batteryOutputKw, 1),
    dieselOutputKw: round(diesel, 1),
    dieselFuelPct: round(opg.dieselFuelPct, 1),
    dieselRunning: opg.dieselRunning,
    demandKw: round(opg.demandKw, 1),
    activeSource: opg.activeSource,
    loadShedding: opg.loadShedding,
    shedLoadKw: round(opg.shedLoadKw, 1),
    totalOutputKw: round(solar + diesel + Math.max(opg.batteryOutputKw, 0), 1),
    updatedAt: nowIso(),
  };
}

function publishPower() {
  publishState("opg/power", powerPayload());
}

function publishSourceStatus() {
  publishState("opg/source/solar/status", {
    source: "SOLAR",
    online: opg.solarEnabled && opg.inverterStatus === "ONLINE",
    outputKw: opg.solarEnabled ? round(opg.solarOutputKw, 1) : 0,
    status: opg.solarEnabled ? opg.inverterStatus : "OFFLINE",
    updatedAt: nowIso(),
  });
  publishState("opg/source/battery/status", {
    source: "BATTERY",
    online: opg.batteryCapacityPct > 2,
    outputKw: round(opg.batteryOutputKw, 1),
    capacityPct: round(opg.batteryCapacityPct, 1),
    status: opg.batteryCapacityPct > 2 ? "ONLINE" : "OFFLINE",
    updatedAt: nowIso(),
  });
  publishState("opg/source/diesel/status", {
    source: "DIESEL",
    online: opg.dieselRunning,
    outputKw: opg.dieselRunning ? round(opg.dieselOutputKw, 1) : 0,
    fuelPct: round(opg.dieselFuelPct, 1),
    status: opg.dieselRunning ? "ONLINE" : "STANDBY",
    updatedAt: nowIso(),
  });
}

function tickPower() {
  // Daylight curve: the lab is mid-morning here, so solar is the default source.
  const daylight = 0.78 + 0.16 * Math.sin((Date.now() / 240_000) % (Math.PI * 2));
  opg.cloudFactor = clamp(opg.cloudFactor + (1 - opg.cloudFactor) * 0.08, 0.15, 1);

  const solarCapacity = opg.solarCapacityKw * daylight * opg.cloudFactor;
  opg.solarOutputKw = clamp(solarCapacity + rand(-6, 6), 0, opg.solarCapacityKw);
  opg.demandKw = clamp(280 + rand(-18, 26), 240, 420);

  const effectiveDemand = opg.loadShedding ? opg.demandKw - opg.shedLoadKw : opg.demandKw;
  const shortfall = effectiveDemand - (opg.solarEnabled ? opg.solarOutputKw : 0);

  // The battery absorbs the residual; it charges when solar exceeds demand.
  opg.batteryOutputKw = clamp(shortfall, -80, 70);
  opg.batteryCapacityPct = clamp(
    opg.batteryCapacityPct + (opg.batteryOutputKw < 0 ? 0.35 : -0.28),
    0,
    100,
  );

  if (opg.batteryCapacityPct < 12 && opg.batteryOutputKw > 0 && !opg.dieselRunning) {
    opg.dieselRunning = true;
    opg.dieselOutputKw = 120;
    console.log("[sim] battery low — diesel generator auto-started");
  }

  if (opg.dieselRunning) {
    opg.dieselOutputKw = clamp(110 + rand(-8, 8), 60, 160);
    opg.dieselFuelPct = clamp(opg.dieselFuelPct - 0.06, 0, 100);
    if (opg.dieselFuelPct <= 0.5) {
      opg.dieselRunning = false;
      opg.dieselOutputKw = 0;
      console.log("[sim] diesel generator ran dry");
    }
  } else {
    opg.dieselOutputKw = 0;
  }

  if (opg.solarDropTicks > 0) opg.solarDropTicks -= 1;
  publishPower();
}

// ---------------------------------------------------------------------------
// Scenarios — one event per rotation so a short demo exercises every alert rule
// ---------------------------------------------------------------------------
const SCENARIO_LIST = [
  "rta-overheat",
  "rta-capacity",
  "rta-wind",
  "mhe-co2",
  "mhe-heart",
  "mhe-airlock",
  "opg-cloud",
  "opg-fuel",
];

let scenarioIndex = 0;

function runScenario(name) {
  console.log(`[sim] scenario: ${name}`);

  switch (name) {
    case "rta-overheat": {
      const dish = dishes.get(pick(DISH_IDS));
      dish.heatBoost = 34;
      dish.temperatureC = Math.max(dish.temperatureC, 58);
      break;
    }
    case "rta-capacity": {
      // Take a whole sub-array offline to cross the 80-dish minimum.
      const targets = DISH_IDS.slice(-24);
      for (const id of targets) {
        const dish = dishes.get(id);
        dish.condition = "OFFLINE";
        dish.temperatureC = 20;
      }
      console.log(`[sim] ${targets.length} dishes offline — capacity alert expected`);
      break;
    }
    case "rta-wind": {
      array.windSpeedMs = rand(23, 27);
      array.stowAfterGust = true;
      break;
    }
    case "mhe-co2": {
      rooms.get("lab").co2Boost = 3200;
      rooms.get("quarters-2").co2Boost = 1400;
      break;
    }
    case "mhe-heart": {
      const member = crew.get(pick(CREW.map((entry) => entry.id)));
      member.heartBoost = 62;
      break;
    }
    case "mhe-airlock": {
      const airlock = rooms.get("airlock");
      airlock.airlockState = "DEPRESSURIZED";
      airlock.pressurized = false;
      break;
    }
    case "opg-cloud": {
      opg.cloudFactor = 0.22;
      opg.solarDropTicks = 6;
      break;
    }
    case "opg-fuel": {
      opg.dieselFuelPct = 12;
      break;
    }
    default:
      break;
  }
}

function tickScenarios() {
  if (!SCENARIOS) return;

  const name = SCENARIO_LIST[scenarioIndex % SCENARIO_LIST.length];
  scenarioIndex += 1;
  runScenario(name);

  // Recovery: winds drop, arrays unstow, airlock repressurizes, fuel is topped up.
  setTimeout(() => {
    if (array.windSpeedMs > 20) {
      array.windSpeedMs = rand(6, 11);
      if (array.stowAfterGust) {
        array.stowAfterGust = false;
        setTimeout(() => unstowArray(), 8_000);
      }
    }
    const airlock = rooms.get("airlock");
    if (airlock && airlock.airlockState === "DEPRESSURIZED") {
      airlock.airlockState = "PRESSURIZED";
      airlock.pressurized = true;
    }
    if (opg.cloudFactor < 0.5) opg.cloudFactor = 1;
  }, 45_000);
}

// ---------------------------------------------------------------------------
// MQTT wiring
// ---------------------------------------------------------------------------
let client = null;
let published = 0;
const timers = [];

function publish(suffix, payload, { retain = false } = {}) {
  if (!client) return;
  client.publish(`${prefix}/${suffix}`, JSON.stringify(payload), { qos: 0, retain }, (error) => {
    if (error) console.warn(`[sim] publish failed on ${suffix}: ${error.message}`);
  });
  published += 1;
}

/**
 * State topics are retained so a dashboard that connects late (or the Next
 * server restarting after the simulator) hydrates immediately instead of
 * waiting a full 2–5 minute cadence. High-frequency topics (scan samples,
 * dish metrics, surveys) are events and stay unretained.
 */
function publishState(suffix, payload) {
  publish(suffix, payload, { retain: true });
}

function onCommand(topic, buffer) {
  const segments = topic.split("/");
  const index = segments.indexOf("cmd");
  if (index === -1) return;

  const service = segments[index - 1]?.toUpperCase();
  const action = segments.slice(index + 1).join("/");
  let envelope = {};
  try {
    envelope = JSON.parse(buffer.toString());
  } catch {
    console.warn(`[sim] malformed command on ${topic}`);
    return;
  }

  const params = envelope.params ?? {};
  console.log(`[sim] cmd ${service} ${action} by ${envelope.issuedBy ?? "unknown"}`);

  if (service === "RTA") {
    if (action === "scan.start") {
      startScan(String(params.targetId ?? "custom"), params);
      return;
    }
    if (action === "scan.pause" && array.status === "SCANNING") {
      array.status = "PAUSED";
      publishState("rta/array/status", arrayStatusPayload());
      return;
    }
    if (action === "scan.resume" && array.status === "PAUSED") {
      array.status = "SCANNING";
      publishState("rta/array/status", arrayStatusPayload());
      return;
    }
    if (action === "scan.cancel") {
      array.status = "CANCELLED";
      array.scanId = null;
      publishState("rta/array/status", arrayStatusPayload());
      return;
    }
    if (action === "array.stow") {
      stowArray("operator command");
      return;
    }
    if (action === "dish.disable" || action === "dish.enable" || action === "dish.stow") {
      const dish = dishes.get(String(params.dishId));
      if (!dish) return;
      dish.condition =
        action === "dish.disable" ? "DISABLED" : action === "dish.stow" ? "STOWED" : "OPERATIONAL";
      publish(`rta/dish/${dish.id}/metrics`, dishPayload(dish));
      publishState("rta/array/status", arrayStatusPayload());
      return;
    }
    if (action === "array.subArray") {
      const dish = dishes.get(String(params.dishId));
      if (!dish) return;
      dish.subArray = String(params.subArray || "main");
      publish(`rta/dish/${dish.id}/metrics`, dishPayload(dish));
      publishState("rta/array/status", arrayStatusPayload());
      return;
    }
  }

  if (service === "MHE") {
    if (action === "room.temperature") {
      const room = rooms.get(String(params.roomId));
      if (!room) return;
      room.setpointC = clamp(Number(params.temperatureC), 12, 30);
      publishState(`mhe/room/${room.roomId}/telemetry`, roomPayload(room));
      return;
    }
    if (action === "room.light") {
      const room = rooms.get(String(params.roomId));
      if (!room) return;
      room.lightLevelPct = clamp(Number(params.lightLevelPct), 0, 100);
      publishState(`mhe/room/${room.roomId}/telemetry`, roomPayload(room));
      return;
    }
    if (action === "crew.wellnessCheck") {
      const member = crew.get(String(params.crewId));
      if (!member) return;
      member.heartBoost = 0;
      member.heartRateBpm = rand(68, 78);
      publishState(`mhe/crew/${member.id}/health`, crewPayload(member));
      console.log(`[sim] wellness check completed for ${member.name}`);
      return;
    }
    if (action === "airlock.pressurize") {
      const airlock = rooms.get(String(params.roomId ?? "airlock"));
      if (!airlock) return;
      airlock.airlockState = "PRESSURIZED";
      airlock.pressurized = true;
      publish(`mhe/room/${airlock.roomId}/telemetry`, roomPayload(airlock));
      return;
    }
  }

  if (service === "OPG") {
    if (action === "source.select") {
      opg.activeSource = ["SOLAR", "BATTERY", "DIESEL"].includes(params.source) ? params.source : "SOLAR";
      publishPower();
      return;
    }
    if (action === "loadShedding.enable") {
      opg.loadShedding = true;
      opg.shedLoadKw = Math.round(opg.demandKw * 0.18);
      publishPower();
      return;
    }
    if (action === "loadShedding.disable") {
      opg.loadShedding = false;
      opg.shedLoadKw = 0;
      publishPower();
      return;
    }
    if (action === "solar.enable") {
      opg.solarEnabled = true;
      opg.inverterStatus = "ONLINE";
      publishPower();
      publishSourceStatus();
      return;
    }
    if (action === "solar.disable") {
      opg.solarEnabled = false;
      opg.inverterStatus = "STANDBY";
      publishPower();
      publishSourceStatus();
      return;
    }
    if (action === "diesel.start") {
      opg.dieselRunning = true;
      opg.dieselOutputKw = 120;
      publishPower();
      publishSourceStatus();
      return;
    }
    if (action === "diesel.stop") {
      opg.dieselRunning = false;
      opg.dieselOutputKw = 0;
      publishPower();
      publishSourceStatus();
    }
  }
}

client = mqtt.connect(brokerUrl, {
  username: config.brokerUser || undefined,
  password: config.brokerPassword || undefined,
  clientId: "arl-simulator",
  clean: true,
  reconnectPeriod: 2_000,
  connectTimeout: 10_000,
  protocolVersion: 4,
});

client.on("connect", () => {
  console.log(`[sim] connected to ${brokerUrl}, prefix "${prefix}"`);
  client.subscribe(`${prefix}/+/cmd/#`, { qos: 1 }, (error) => {
    if (error) console.warn(`[sim] command subscribe failed: ${error.message}`);
  });

  // Seed the dashboards immediately, then continue at the documented cadence.
  publishAllDishes();
  publishAllRooms();
  publishAllCrew();
  submitSurveys();
  publishPower();
  publishSourceStatus();
  console.log("[sim] initial state published");
});

client.on("message", (topic, buffer) => {
  if (!topic.includes("/cmd/")) return;
  try {
    onCommand(topic, buffer);
  } catch (error) {
    console.warn(`[sim] command handling failed: ${error.message}`);
  }
});

client.on("reconnect", () => console.log("[sim] reconnecting…"));
client.on("error", (error) => console.warn(`[sim] mqtt error: ${error.message}`));

// --- Cadence timers --------------------------------------------------------
timers.push(
  setInterval(() => {
    driftDishes();
    publishAllDishes();
  }, CADENCE.dishMetricsMs),
);
timers.push(setInterval(publishScanTick, CADENCE.scanTickMs));
timers.push(setInterval(() => publishState("rta/array/status", arrayStatusPayload()), 15_000));

timers.push(
  setInterval(() => {
    driftRooms();
    publishAllRooms();
  }, CADENCE.roomTelemetryMs),
);
timers.push(
  setInterval(() => {
    driftCrew();
    publishAllCrew();
  }, CADENCE.crewHealthMs),
);
timers.push(setInterval(() => publishState("mhe/habitat/status", habitatPayload()), CADENCE.habitatMs));

timers.push(setInterval(tickPower, CADENCE.powerMs));
timers.push(setInterval(publishSourceStatus, CADENCE.sourceStatusMs));

// Compressed mission clock: a new mission day, then surveys twice per day.
timers.push(
  setInterval(() => {
    habitat.missionDay += 1;
    console.log(`[sim] mission day ${habitat.missionDay}`);
  }, CADENCE.missionDayMs),
);
timers.push(setInterval(submitSurveys, Math.round(CADENCE.missionDayMs / 2)));

// One scripted event per rotation, with a lead-in so the console is populated first.
if (SCENARIOS) {
  const scenarioTimer = setInterval(tickScenarios, envNumber("SIM_SCENARIO_MS", 120_000));
  timers.push(scenarioTimer);
  setTimeout(tickScenarios, 25_000);
}

// Periodic console summary.
timers.push(
  setInterval(() => {
    console.log(
      `[sim] ${published} publishes · array ${array.status} · ${operationalDishCount()} dishes · ` +
        `battery ${opg.batteryCapacityPct.toFixed(0)}% · demand ${opg.demandKw.toFixed(0)} kW`,
    );
  }, 60_000),
);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sim] ${signal} received, stopping…`);
  for (const timer of timers) clearInterval(timer);
  if (client) {
    client.end(false, {}, () => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
