import type { ParsedTopic } from "./topics";
import {
  MHE_CO2_LIMIT_PPM,
  MHE_HEART_RATE_LIMIT_BPM,
  MHE_SURVEY_INTERVAL_MS,
  MHE_TELEMETRY_STALE_MS,
  OPG_BATTERY_CRITICAL_PCT,
  OPG_DIESEL_LOW_FUEL_PCT,
  RTA_DISH_TEMP_LIMIT_C,
  RTA_MIN_OPERATIONAL_DISHES,
  RTA_WIND_STOW_LIMIT_MS,
  type AlertFlag,
  type DishCondition,
} from "./types";

/**
 * Deterministic threshold rules evaluated by the ingestion worker.
 *
 * `observe` runs on every inbound message and returns the alert flags that
 * should be raised; `tick` runs on a timer and covers time-based conditions
 * (lost telemetry, missing surveys) that no single message can detect.
 *
 * Alert type naming: `SERVICE_CONDITION` for service-wide conditions and
 * `SERVICE_CONDITION:<entityId>` for entity-scoped ones, which keeps the
 * (service, alertType) dedupe key in lib/alerts.ts precise.
 */

interface DishState {
  condition: DishCondition;
  temperatureC: number;
  updatedAt: number;
}

interface RoomState {
  lastTelemetryAt: number;
  co2Ppm: number;
  airlockState: string | null;
}

interface CrewState {
  firstSeenAt: number;
  lastHealthAt: number;
  lastSurveyAt: number | null;
}

interface ArrayState {
  windSpeedMs: number | null;
  operationalDishes: number | null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

/** Extract explicit alert flags embedded in a telemetry payload. */
export function extractPayloadAlertFlags(
  payload: Record<string, unknown>,
  topic: string,
): AlertFlag[] {
  const flags: AlertFlag[] = [];

  const push = (type: unknown, message: unknown, fallbackType: string) => {
    const resolvedType = str(type) ?? fallbackType;
    if (!resolvedType) return;
    flags.push({
      type: resolvedType.toUpperCase().replace(/\s+/g, "_"),
      message: str(message) ?? `Alert flag raised on ${topic}`,
    });
  };

  const singular = payload.alert ?? payload.alertFlag ?? payload.alarm;
  const plural = payload.alerts ?? payload.alertFlags ?? payload.alarms;

  if (typeof singular === "string" && singular.trim()) {
    push(payload.alertType ?? payload.type, payload.alertMessage ?? singular, singular);
  } else if (singular && typeof singular === "object") {
    const record = singular as Record<string, unknown>;
    push(record.type ?? record.alertType ?? record.code, record.message ?? record.detail, "TELEMETRY_ALERT");
  } else if (singular === true) {
    push(payload.alertType ?? payload.type ?? "TELEMETRY_ALERT", payload.alertMessage ?? payload.message, "TELEMETRY_ALERT");
  }

  if (Array.isArray(plural)) {
    for (const entry of plural) {
      if (typeof entry === "string") {
        push(entry, null, entry);
      } else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        push(record.type ?? record.alertType ?? record.code, record.message ?? record.detail, "TELEMETRY_ALERT");
      }
    }
  }

  // Boolean convention: `overheatAlert: true`.
  for (const [key, value] of Object.entries(payload)) {
    if (!/Alert$/.test(key) || key === "alert") continue;
    if (bool(value) !== true) continue;
    const type = key.replace(/Alert$/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    push(payload.alertType ?? type, payload.alertMessage, type);
  }

  // Deduplicate identical flags produced by overlapping conventions.
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.type}|${flag.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class AlertRuleEngine {
  private dishes = new Map<string, DishState>();
  private array = new Map<string, ArrayState>();
  private rooms = new Map<string, RoomState>();
  private crew = new Map<string, CrewState>();
  private solarHistory: number[] = [];

  reset(): void {
    this.dishes.clear();
    this.array.clear();
    this.rooms.clear();
    this.crew.clear();
    this.solarHistory = [];
  }

  observe(parsed: ParsedTopic, payload: Record<string, unknown>, at: Date): AlertFlag[] {
    const now = at.getTime();
    switch (parsed.kind) {
      case "rta.array.status":
        return this.observeArrayStatus(payload, now);
      case "rta.dish.metrics":
        return this.observeDish(parsed.entityId, payload, now);
      case "mhe.room.telemetry":
        return this.observeRoom(parsed.entityId, payload, now);
      case "mhe.crew.health":
        return this.observeCrewHealth(parsed.entityId, payload, now);
      case "mhe.crew.survey":
        return this.observeSurvey(parsed.entityId, payload, now);
      case "opg.power":
        return this.observePower(payload, now);
      default:
        return [];
    }
  }

  tick(at: Date = new Date()): AlertFlag[] {
    const now = at.getTime();
    const flags: AlertFlag[] = [];

    for (const [roomId, room] of this.rooms) {
      if (now - room.lastTelemetryAt > MHE_TELEMETRY_STALE_MS) {
        flags.push({
          type: `MHE_TELEMETRY_LOST:${roomId}`,
          message: `No telemetry from ${roomId} for over ${Math.round(
            MHE_TELEMETRY_STALE_MS / 60000,
          )} minutes.`,
        });
      }
    }

    for (const [crewId, member] of this.crew) {
      const reference = member.lastSurveyAt ?? member.firstSeenAt;
      if (now - reference > MHE_SURVEY_INTERVAL_MS) {
        flags.push({
          type: `MHE_SURVEY_MISSING:${crewId}`,
          message: `Crew survey missing for ${crewId}: no submission in the last ${
            MHE_SURVEY_INTERVAL_MS / 3600000
          } hours.`,
        });
      }
    }

    return flags;
  }

  private observeArrayStatus(payload: Record<string, unknown>, now: number): AlertFlag[] {
    const flags: AlertFlag[] = [];

    const wind = num(payload.windSpeedMs ?? payload.windSpeed ?? payload.wind_ms);
    const operational = num(payload.operationalDishes ?? payload.operational_dishes);

    for (const key of ["RTA", "MAIN"]) {
      const state = this.array.get(key) ?? { windSpeedMs: null, operationalDishes: null };
      if (wind !== null) state.windSpeedMs = wind;
      if (operational !== null) state.operationalDishes = operational;
      this.array.set(key, state);
    }
    const state = this.array.get("RTA")!;

    if (wind !== null && wind >= RTA_WIND_STOW_LIMIT_MS) {
      flags.push({
        type: "RTA_WIND_STOW",
        message: `Wind speed ${wind.toFixed(1)} m/s exceeds the ${RTA_WIND_STOW_LIMIT_MS} m/s limit — emergency stowage required.`,
      });
    }

    if (operational !== null && operational < RTA_MIN_OPERATIONAL_DISHES) {
      flags.push({
        type: "RTA_DISH_CAPACITY_LOW",
        message: `Operational dishes dropped to ${operational} (minimum ${RTA_MIN_OPERATIONAL_DISHES}).`,
      });
    }

    // If the array report does not include the count, derive it from dish metrics.
    if (operational === null && this.dishes.size >= RTA_MIN_OPERATIONAL_DISHES) {
      const count = this.countOperationalDishes();
      if (count < RTA_MIN_OPERATIONAL_DISHES) {
        flags.push({
          type: "RTA_DISH_CAPACITY_LOW",
          message: `Operational dishes dropped to ${count} of ${this.dishes.size} reporting (minimum ${RTA_MIN_OPERATIONAL_DISHES}).`,
        });
      }
    }

    return flags;
  }

  private countOperationalDishes(): number {
    let count = 0;
    for (const dish of this.dishes.values()) {
      if (dish.condition === "OPERATIONAL" || dish.condition === "DEGRADED") count += 1;
    }
    return count;
  }

  private observeDish(entityId: string | null, payload: Record<string, unknown>, now: number): AlertFlag[] {
    const dishId = str(payload.dishId) ?? entityId;
    if (!dishId) return [];

    const rawCondition = (str(payload.condition) ?? "OPERATIONAL").toUpperCase();
    const condition: DishCondition =
      rawCondition === "DEGRADED" ||
      rawCondition === "OFFLINE" ||
      rawCondition === "DISABLED" ||
      rawCondition === "STOWED"
        ? rawCondition
        : "OPERATIONAL";

    const temperature = num(payload.temperatureC ?? payload.temperature) ?? 0;
    this.dishes.set(dishId, { condition, temperatureC: temperature, updatedAt: now });

    const flags: AlertFlag[] = [];

    if (temperature >= RTA_DISH_TEMP_LIMIT_C && condition !== "DISABLED") {
      flags.push({
        type: `RTA_DISH_OVERHEAT:${dishId}`,
        message: `${dishId} temperature ${temperature.toFixed(1)} °C exceeds the ${RTA_DISH_TEMP_LIMIT_C} °C safe limit.`,
      });
    }

    if (this.dishes.size >= RTA_MIN_OPERATIONAL_DISHES) {
      const operational = this.countOperationalDishes();
      if (operational < RTA_MIN_OPERATIONAL_DISHES) {
        flags.push({
          type: "RTA_DISH_CAPACITY_LOW",
          message: `Only ${operational} of ${this.dishes.size} dishes are operational (minimum ${RTA_MIN_OPERATIONAL_DISHES}).`,
        });
      }
    }

    return flags;
  }

  private observeRoom(entityId: string | null, payload: Record<string, unknown>, now: number): AlertFlag[] {
    const roomId = str(payload.roomId) ?? entityId;
    if (!roomId) return [];

    const co2 = num(payload.co2Ppm ?? payload.co2) ?? 0;
    const airlockState = str(payload.airlockState ?? payload.state);
    const pressurized = bool(payload.pressurized);
    this.rooms.set(roomId, { lastTelemetryAt: now, co2Ppm: co2, airlockState });

    const flags: AlertFlag[] = [];
    if (co2 >= MHE_CO2_LIMIT_PPM) {
      flags.push({
        type: `MHE_CO2_HIGH:${roomId}`,
        message: `CO₂ at ${Math.round(co2)} ppm in ${roomId} (limit ${MHE_CO2_LIMIT_PPM} ppm).`,
      });
    }

    const isAirlock = roomId.toLowerCase() === "airlock";
    if (isAirlock && (pressurized === false || airlockState === "DEPRESSURIZED")) {
      flags.push({
        type: "MHE_AIRLOCK_UNPRESSURIZED",
        message:
          airlockState === "CYCLING"
            ? "Airlock is cycling pressure with the habitat occupied."
            : "Airlock is depressurized — habitability check required.",
      });
    }

    return flags;
  }

  private observeCrewHealth(entityId: string | null, payload: Record<string, unknown>, now: number): AlertFlag[] {
    const crewId = str(payload.crewId) ?? entityId;
    if (!crewId) return [];

    const existing = this.crew.get(crewId);
    const heartRate = num(payload.heartRateBpm ?? payload.heartRate) ?? 0;
    this.crew.set(crewId, {
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastHealthAt: now,
      lastSurveyAt: existing?.lastSurveyAt ?? null,
    });

    if (heartRate >= MHE_HEART_RATE_LIMIT_BPM) {
      return [
        {
          type: `MHE_HEART_RATE_SPIKE:${crewId}`,
          message: `${crewId} heart rate ${Math.round(heartRate)} bpm exceeds ${MHE_HEART_RATE_LIMIT_BPM} bpm — wellness check required.`,
        },
      ];
    }
    return [];
  }

  private observeSurvey(entityId: string | null, payload: Record<string, unknown>, now: number): AlertFlag[] {
    const crewId = str(payload.crewId) ?? entityId;
    if (!crewId) return [];
    const existing = this.crew.get(crewId);
    this.crew.set(crewId, {
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastHealthAt: existing?.lastHealthAt ?? now,
      lastSurveyAt: now,
    });
    return [];
  }

  private observePower(payload: Record<string, unknown>, now: number): AlertFlag[] {
    const flags: AlertFlag[] = [];

    const solar = num(payload.solarOutputKw ?? payload.solarOutput) ?? 0;
    const diesel = num(payload.dieselOutputKw ?? payload.dieselOutput) ?? 0;
    const batteryOutput = num(payload.batteryOutputKw ?? payload.batteryOutput) ?? 0;
    const reportedTotal = num(payload.totalOutputKw ?? payload.totalOutput);
    const total = reportedTotal ?? Math.max(solar, 0) + Math.max(diesel, 0) + Math.max(batteryOutput, 0);
    const demand = num(payload.demandKw ?? payload.demand);
    const batteryCapacity = num(payload.batteryCapacityPct ?? payload.batteryCapacity);
    const fuel = num(payload.dieselFuelPct ?? payload.dieselFuel);
    const solarEnabled = bool(payload.solarEnabled) ?? true;

    if (demand !== null && demand > 0 && total < demand) {
      flags.push({
        type: "OPG_POWER_DEFICIT",
        message: `Total output ${total.toFixed(1)} kW is below lab demand ${demand.toFixed(1)} kW.`,
      });
    }

    if (batteryCapacity !== null && batteryCapacity <= OPG_BATTERY_CRITICAL_PCT) {
      flags.push({
        type: "OPG_BATTERY_CRITICAL",
        message: `Battery capacity at ${batteryCapacity.toFixed(1)}% (critical threshold ${OPG_BATTERY_CRITICAL_PCT}%).`,
      });
    }

    if (fuel !== null && fuel <= OPG_DIESEL_LOW_FUEL_PCT) {
      flags.push({
        type: "OPG_DIESEL_LOW_FUEL",
        message: `Diesel fuel at ${fuel.toFixed(1)}% (reserve threshold ${OPG_DIESEL_LOW_FUEL_PCT}%).`,
      });
    }

    this.solarHistory.push(solar);
    if (this.solarHistory.length > 10) this.solarHistory.shift();
    if (solarEnabled && this.solarHistory.length >= 4) {
      const average =
        this.solarHistory.slice(0, -1).reduce((sum, value) => sum + value, 0) /
        (this.solarHistory.length - 1);
      if (average > 5 && solar < average * 0.5) {
        flags.push({
          type: "OPG_SOLAR_DROP",
          message: `Solar output fell to ${solar.toFixed(1)} kW from a ${average.toFixed(
            1,
          )} kW baseline — array or inverter fault suspected.`,
        });
      }
    }

    // Keep the timestamp referenced so `now` is not flagged as unused for future rules.
    void now;
    return flags;
  }
}
