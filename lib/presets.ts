import type { Service } from "./types";

/**
 * Researcher presets.
 *
 * A preset is the sequence an experienced operator would actually run, not a
 * single control: setting a band is pointless without starting the scan, and
 * starting a generator without protecting the battery reserve is how a night
 * ends in the dark. Presets are declared as data so the console can show the
 * whole sequence — with its rationale — before anything is published.
 *
 * `entity: "@selected"` steps take whatever dish or room the operator has
 * selected; a preset that needs one is disabled until there is a selection.
 */

export type PresetEntity = string | "@selected";

export interface PresetStep {
  control: string;
  entity?: PresetEntity;
  value: unknown;
  label: string;
  /** Stop the preset when this step is rejected (later steps assume it). */
  critical?: boolean;
}

export interface ControlPreset {
  id: string;
  service: Service;
  name: string;
  /** Why a researcher would run this, in their own terms. */
  rationale: string;
  /** Preconditions the operator should see before confirming. */
  requires?: string;
  steps: PresetStep[];
}

export const PRESETS: ControlPreset[] = [
  // ---------------------------------------------------------------- RTA ---
  {
    id: "rta-lband-survey",
    service: "RTA",
    name: "L-band survey",
    rationale:
      "The 21 cm hydrogen line is the default survey band. Set the receiver, then start a scan on the target already committed to the sub-array.",
    requires: "A target above the horizon and at least three operational dishes.",
    steps: [
      {
        control: "set_observation_frequency",
        entity: "main",
        value: 1.42e9,
        label: "Band → 1420 MHz",
        critical: true,
      },
      { control: "start_scan", entity: "main", value: true, label: "Start scan", critical: true },
    ],
  },
  {
    id: "rta-stop",
    service: "RTA",
    name: "Stop observing",
    rationale:
      "Ends the session cleanly so the array stops accumulating integration time and the last scan image is kept for replay.",
    steps: [{ control: "cancel_scan", entity: "main", value: true, label: "Cancel scan" }],
  },
  {
    id: "rta-recover",
    service: "RTA",
    name: "Recover a hot dish",
    rationale:
      "A dish above the temperature limit degrades the array. Recalibrating resets its system-temperature drift without taking it out of service entirely.",
    requires: "Select the affected dish in the rack first.",
    steps: [
      {
        control: "request_recalibration",
        entity: "@selected",
        value: true,
        label: "Request recalibration",
        critical: true,
      },
    ],
  },

  // ---------------------------------------------------------------- MHE ---
  {
    id: "mhe-night",
    service: "MHE",
    name: "Habitat night cycle",
    rationale:
      "Crew sleep 20:00–06:00. Cool the room slightly, drop the lights and keep enough ventilation to hold CO₂ down overnight.",
    requires: "Select a room first; rooms other than quarters still accept it.",
    steps: [
      { control: "adjust_temperature", entity: "@selected", value: 293.15, label: "Setpoint 293 K" },
      { control: "ventilation", entity: "@selected", value: 120, label: "Ventilation 120 m³/h" },
      {
        control: "lighting_schedule",
        entity: "@selected",
        value: { start: "20:00", end: "06:00", level_lux: 0 },
        label: "Lights off overnight",
      },
    ],
  },
  {
    id: "mhe-workday",
    service: "MHE",
    name: "Habitat work day",
    rationale:
      "Day shift: 22 °C, working light levels and full ventilation while the crew is awake and the lab is in use.",
    requires: "Select a room first.",
    steps: [
      { control: "adjust_temperature", entity: "@selected", value: 295.15, label: "Setpoint 295 K" },
      { control: "ventilation", entity: "@selected", value: 260, label: "Ventilation 260 m³/h" },
      {
        control: "lighting_schedule",
        entity: "@selected",
        value: { start: "06:00", end: "20:00", level_lux: 400 },
        label: "Work lighting",
      },
    ],
  },
  {
    id: "mhe-hydroponics",
    service: "MHE",
    name: "Hydroponics crop day",
    rationale:
      "The hydroponics bay needs far more light than a crewed room; this sets the high-output schedule and a morning watering window.",
    steps: [
      {
        control: "lighting_schedule",
        entity: "hydroponics",
        value: { start: "06:00", end: "22:00", level_lux: 24000 },
        label: "Grow lights 24 000 lx",
      },
      {
        control: "irrigation_schedule",
        entity: "hydroponics",
        value: { start: "06:30", end: "07:00", volume_l: 120 },
        label: "Water 120 L",
      },
    ],
  },

  // ---------------------------------------------------------------- OPG ---
  {
    id: "opg-solar-day",
    service: "OPG",
    name: "Solar day",
    rationale:
      "Daylight is free power. Draw solar first, keep a modest reserve and leave load shedding off while the array covers demand.",
    steps: [
      {
        control: "generation_priority",
        entity: "global",
        value: "solar_first",
        label: "Priority → solar",
        critical: true,
      },
      { control: "enable_solar_array", entity: "solar", value: true, label: "Enable solar array" },
      { control: "load_shed", entity: "global", value: false, label: "Load shedding off" },
      { control: "battery_reserve", entity: "batteries", value: 20, label: "Reserve 20 %" },
    ],
  },
  {
    id: "opg-night-watch",
    service: "OPG",
    name: "Night watch",
    rationale:
      "No irradiance for hours. Run from the battery, keep a deep reserve and reserve diesel for a real shortfall.",
    steps: [
      {
        control: "generation_priority",
        entity: "global",
        value: "battery_first",
        label: "Priority → battery",
        critical: true,
      },
      { control: "battery_reserve", entity: "batteries", value: 45, label: "Reserve 45 %" },
      { control: "load_shed", entity: "global", value: false, label: "Load shedding off" },
    ],
  },
  {
    id: "opg-grid-down",
    service: "OPG",
    name: "Shortfall response",
    rationale:
      "Generation is below demand. Protect the reserve first, start the diesel plant, and shed non-essential loads until supply recovers.",
    requires: "Diesel fuel above 2 %.",
    steps: [
      { control: "load_shed", entity: "global", value: true, label: "Shed non-essential load", critical: true },
      {
        control: "generation_priority",
        entity: "global",
        value: "diesel_first",
        label: "Priority → diesel",
      },
      { control: "start_generator", entity: "diesel", value: true, label: "Start generator" },
    ],
  },

  // ---------------------------------------------------------------- LWM ---
  {
    id: "lwm-clean-reference",
    service: "LWM",
    name: "Restore the soiling reference",
    rationale:
      "A soiling ratio below 0.9 means the reference cell is dirty, not that the sun dimmed. Cleaning it and then recalibrating restores the pair the solar yield is measured against.",
    requires: "The reference cell must not be mid-clean already.",
    steps: [
      {
        control: "clean_reference_cell",
        entity: "lwm-4",
        value: true,
        label: "Clean the reference cell",
        critical: true,
      },
      {
        control: "request_recalibration",
        entity: "lwm-4",
        value: true,
        label: "Recalibrate the reference cell",
      },
    ],
  },
  {
    id: "lwm-service-anemometer",
    service: "LWM",
    name: "Service an anemometer",
    rationale:
      "A stuck or drifting anemometer is how the array ends up stowing late. Servicing it and then recalibrating the station is the sequence an instrument technician runs.",
    requires: "Select the affected station first; no gust data is published while the service runs.",
    steps: [
      {
        control: "service_anemometer",
        entity: "@selected",
        value: true,
        label: "Service the anemometer",
        critical: true,
      },
      {
        control: "request_recalibration",
        entity: "@selected",
        value: true,
        label: "Recalibrate the station",
      },
    ],
  },
];

export function presetsFor(service: Service): ControlPreset[] {
  return PRESETS.filter((preset) => preset.service === service);
}

/** True when the preset needs a dish/room selection to run. */
export function presetNeedsSelection(preset: ControlPreset): boolean {
  return preset.steps.some((step) => step.entity === "@selected");
}
