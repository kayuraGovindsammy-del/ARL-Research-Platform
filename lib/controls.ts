import type { Service } from "./types";

/**
 * Control catalogue mirrored from each service's `$topology` document.
 *
 * Publishing an out-of-range value is rejected by the service with an ack
 * `{"state":"rejected","reason":"invalid_value"}`, so validating here keeps the
 * operator's feedback immediate and the audit trail meaningful. The catalogue
 * drives both the API route and the dashboard control panels.
 */

export type ControlValueType =
  | "bool"
  | "float"
  | "timestamp"
  | "string"
  | "enum"
  | "object"
  | "target";

export interface ControlField {
  key: string;
  type: "string" | "float" | "integer";
  min?: number;
  max?: number;
  unit?: string;
}

export interface ControlSpec {
  service: Service;
  control: string;
  entityKind: string;
  entity?: string;
  valueType: ControlValueType;
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  values?: string[];
  mustBeTrue?: boolean;
  fields?: ControlField[];
  /** Tighter bound for a specific entity (e.g. hydroponics lux). */
  maxByEntity?: Record<string, number>;
}

export const CONTROLS: ControlSpec[] = [
  // ---------------------------------------------------------------- RTA ----
  {
    service: "RTA",
    control: "start_scan",
    entityKind: "subarray",
    entity: "main",
    valueType: "bool",
    mustBeTrue: true,
    label: "Start scan",
    description:
      "Starts a scan now, or resumes a paused scan. Needs a target at least 15° above the horizon, three dishes in service and no wind stow.",
  },
  {
    service: "RTA",
    control: "schedule_scan",
    entityKind: "subarray",
    entity: "main",
    valueType: "timestamp",
    label: "Schedule scan",
    description: "Sets the next scan time; 0 clears it. Must be in the future and not while scanning.",
  },
  {
    service: "RTA",
    control: "pause_scan",
    entityKind: "subarray",
    entity: "main",
    valueType: "bool",
    mustBeTrue: true,
    label: "Pause scan",
    description: "Pauses a running scan; dishes keep reporting with unchanged progress.",
  },
  {
    service: "RTA",
    control: "cancel_scan",
    entityKind: "subarray",
    entity: "main",
    valueType: "bool",
    mustBeTrue: true,
    label: "Cancel scan",
    description: "Cancels a running, paused or scheduled scan.",
  },
  {
    service: "RTA",
    control: "set_target",
    entityKind: "subarray",
    entity: "main",
    valueType: "target",
    label: "Set target",
    description:
      "Sets what the sub-array observes: a catalogue id, or a position {ra_rad, dec_rad, fov_rad}. Not while scanning.",
  },
  {
    service: "RTA",
    control: "set_observation_frequency",
    entityKind: "subarray",
    entity: "main",
    valueType: "float",
    unit: "Hz",
    min: 5e8,
    max: 5e10,
    label: "Observation frequency",
    description: "Sets the band the sub-array observes, 500 MHz to 50 GHz. Not while scanning.",
  },
  {
    service: "RTA",
    control: "assign_subarray",
    entityKind: "dish",
    valueType: "string",
    label: "Assign sub-array",
    description: "Moves the dish to a sub-array; a new name creates one (four maximum).",
  },
  {
    service: "RTA",
    control: "adjust_azimuth",
    entityKind: "dish",
    valueType: "float",
    unit: "rad",
    min: 0,
    max: Math.PI * 2,
    label: "Adjust azimuth",
    description: "Slews the dish to a new azimuth. Not while scanning or stowed.",
  },
  {
    service: "RTA",
    control: "adjust_elevation",
    entityKind: "dish",
    valueType: "float",
    unit: "rad",
    min: 0.0873,
    max: 1.5708,
    label: "Adjust elevation",
    description: "Slews the dish to a new elevation. Not while scanning or stowed.",
  },
  {
    service: "RTA",
    control: "enable_dish",
    entityKind: "dish",
    valueType: "bool",
    label: "Enable / disable dish",
    description: "true puts the dish in service, false takes it out of the array and any scan.",
  },
  {
    service: "RTA",
    control: "stow_dish",
    entityKind: "dish",
    valueType: "bool",
    label: "Stow dish",
    description:
      "true points the dish straight up and holds it there; false releases it. Rejected during wind stow.",
  },
  {
    service: "RTA",
    control: "request_recalibration",
    entityKind: "dish",
    valueType: "bool",
    mustBeTrue: true,
    label: "Request recalibration",
    description: "Calibrates the dish over 120 s, resetting its system-temperature drift.",
  },

  // ---------------------------------------------------------------- MHE ----
  {
    service: "MHE",
    control: "adjust_temperature",
    entityKind: "room",
    valueType: "float",
    unit: "K",
    min: 285,
    max: 300,
    label: "Temperature setpoint",
    description: "Room temperature setpoint in kelvin (285–300 K).",
  },
  {
    service: "MHE",
    control: "adjust_humidity",
    entityKind: "room",
    valueType: "float",
    unit: "%",
    min: 20,
    max: 80,
    label: "Humidity setpoint",
    description: "Room relative-humidity setpoint, 20–80 %.",
  },
  {
    service: "MHE",
    control: "lighting_schedule",
    entityKind: "room",
    valueType: "object",
    label: "Lighting schedule",
    description: "Daily lighting window and level: {start, end, level_lux}.",
    fields: [
      { key: "start", type: "string" },
      { key: "end", type: "string" },
      { key: "level_lux", type: "float", min: 0, max: 1000, unit: "lx" },
    ],
    maxByEntity: { hydroponics: 30000 },
  },
  {
    service: "MHE",
    control: "ventilation",
    entityKind: "room",
    valueType: "float",
    unit: "m3/h",
    min: 0,
    max: 400,
    label: "Ventilation",
    description: "Ventilation rate, 0–400 m³/h.",
  },
  {
    service: "MHE",
    control: "environmental_systems",
    entityKind: "room",
    valueType: "bool",
    label: "Environmental systems",
    description: "Enables or disables the room's climate control.",
  },
  {
    service: "MHE",
    control: "seal_room",
    entityKind: "room",
    valueType: "bool",
    label: "Seal room",
    description: "Seals or unseals the room.",
  },
  {
    service: "MHE",
    control: "crew_wellness_check",
    entityKind: "crew",
    valueType: "bool",
    mustBeTrue: true,
    label: "Wellness check",
    description: "Asks the crew member to complete a wellness check.",
  },
  {
    service: "MHE",
    control: "cycle_airlock",
    entityKind: "room",
    entity: "airlock",
    valueType: "enum",
    values: ["pressurise", "depressurise"],
    label: "Cycle airlock",
    description: "Pressurises or depressurises the airlock.",
  },
  {
    service: "MHE",
    control: "irrigation_schedule",
    entityKind: "room",
    entity: "hydroponics",
    valueType: "object",
    label: "Irrigation schedule",
    description: "Hydroponics watering window and volume: {start, end, volume_l}.",
    fields: [
      { key: "start", type: "string" },
      { key: "end", type: "string" },
      { key: "volume_l", type: "float", min: 0, max: 500, unit: "L" },
    ],
  },

  // ---------------------------------------------------------------- OPG ----
  {
    service: "OPG",
    control: "generation_priority",
    entityKind: "service",
    entity: "global",
    valueType: "enum",
    values: ["solar_first", "battery_first", "diesel_first"],
    label: "Generation priority",
    description: "Order in which the plant draws on solar, batteries and diesel.",
  },
  {
    service: "OPG",
    control: "load_shed",
    entityKind: "service",
    entity: "global",
    valueType: "bool",
    label: "Load shedding",
    description: "Sheds non-essential loads to protect the battery reserve.",
  },
  {
    service: "OPG",
    control: "enable_solar_array",
    entityKind: "array",
    entity: "solar",
    valueType: "bool",
    label: "Solar array",
    description: "Enables or disables the solar array.",
  },
  {
    service: "OPG",
    control: "battery_reserve",
    entityKind: "bank",
    entity: "batteries",
    valueType: "float",
    unit: "%",
    min: 10,
    max: 80,
    label: "Battery reserve",
    description: "Minimum state of charge kept for emergencies, 10–80 %.",
  },
  {
    service: "OPG",
    control: "start_generator",
    entityKind: "generators",
    entity: "diesel",
    valueType: "bool",
    mustBeTrue: true,
    label: "Start generator",
    description: "Starts the diesel generator (30 s); rejected below 2 % fuel.",
  },
  {
    service: "OPG",
    control: "stop_generator",
    entityKind: "generators",
    entity: "diesel",
    valueType: "bool",
    mustBeTrue: true,
    label: "Stop generator",
    description: "Stops the diesel generator after a 60 s cool-down.",
  },


];

/** What the `entity` path segment must be for each kind of control. */
export const CONTROL_ENTITY_HINT: Record<string, string> = {
  dish: "dish id, e.g. dish-042",
  room: "room id, e.g. quarters-3",
  crew: "crew id, e.g. crew-2",
  subarray: "sub-array name",
  service: "global",
  array: "solar",
  bank: "batteries",
  generators: "diesel",
};

export function getControl(service: Service, control: string): ControlSpec | null {
  return (
    CONTROLS.find((spec) => spec.service === service && spec.control === control) ?? null
  );
}

export function controlsFor(service: Service): ControlSpec[] {
  return CONTROLS.filter((spec) => spec.service === service);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a control value against the catalogue.
 * Returns a human-readable error, or null when the value is acceptable.
 */
export function validateControlValue(
  spec: ControlSpec,
  value: unknown,
  entity: string,
): string | null {
  switch (spec.valueType) {
    case "bool":
      if (typeof value !== "boolean") return `${spec.label} expects true or false.`;
      if (spec.mustBeTrue && value !== true) return `${spec.label} only accepts true.`;
      return null;

    case "float": {
      if (!isFiniteNumber(value)) return `${spec.label} expects a number.`;
      if (spec.min !== undefined && value < spec.min) {
        return `${spec.label} must be at least ${spec.min}${spec.unit ? ` ${spec.unit}` : ""}.`;
      }
      if (spec.max !== undefined && value > spec.max) {
        return `${spec.label} must be at most ${spec.max}${spec.unit ? ` ${spec.unit}` : ""}.`;
      }
      return null;
    }

    case "timestamp":
      if (!isFiniteNumber(value)) return `${spec.label} expects epoch milliseconds.`;
      if (value !== 0 && value <= Date.now()) return `${spec.label} must be in the future.`;
      return null;

    case "string":
      if (typeof value !== "string" || value.trim().length === 0) {
        return `${spec.label} expects a non-empty string.`;
      }
      return null;

    case "enum":
      if (typeof value !== "string" || !spec.values?.includes(value)) {
        return `${spec.label} expects one of: ${spec.values?.join(", ")}.`;
      }
      return null;

    case "target": {
      if (typeof value === "string" && value.trim()) return null;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "Set target expects a catalogue id or {ra_rad, dec_rad, fov_rad}.";
      }
      const record = value as Record<string, unknown>;
      const { ra_rad: ra, dec_rad: dec, fov_rad: fov } = record;
      if (!isFiniteNumber(ra) || ra < 0 || ra > Math.PI * 2) {
        return "ra_rad must be between 0 and 2π.";
      }
      if (!isFiniteNumber(dec) || dec < -Math.PI / 2 || dec > Math.PI / 2) {
        return "dec_rad must be between -π/2 and π/2.";
      }
      if (!isFiniteNumber(fov) || fov < 0.0005 || fov > 0.05) {
        return "fov_rad must be between 0.0005 and 0.05 rad.";
      }
      return null;
    }

    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return `${spec.label} expects an object with ${spec.fields?.map((f) => f.key).join(", ")}.`;
      }
      const record = value as Record<string, unknown>;
      for (const field of spec.fields ?? []) {
        const fieldValue = record[field.key];
        if (field.type === "string") {
          if (typeof fieldValue !== "string" || !HHMM.test(fieldValue)) {
            return `${field.key} must be a HH:MM time.`;
          }
        } else if (field.type === "float" || field.type === "integer") {
          if (!isFiniteNumber(fieldValue)) return `${field.key} must be a number.`;
          const max = spec.maxByEntity?.[entity] ?? field.max;
          if (field.min !== undefined && fieldValue < field.min) {
            return `${field.key} must be at least ${field.min}.`;
          }
          if (max !== undefined && fieldValue > max) {
            return `${field.key} must be at most ${max}.`;
          }
        }
      }
      return null;
    }

    default:
      return `${spec.label} has an unsupported value type.`;
  }
}

/** Display label for an alert type such as `dish_temperature:dish-012`. */
export function humanizeToken(token: string): string {
  return token
    .replace(/[_:.]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}
