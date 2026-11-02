/**
 * Alert guidance: the "so what do I do?" half of an alert.
 *
 * An alert that only says *low battery* still leaves the researcher to work out
 * the remedy under time pressure. Every service alert type the lab can raise
 * therefore maps to a short, concrete recommended action, phrased in terms of
 * the controls this platform actually offers. The mapping is matched on a
 * normalised substring of the alert type so `battery_soc_low`,
 * `battery.state_of_charge` and `BATTERY_SOC` all land on the same guidance.
 *
 * The table is data, not code: the annunciator renders it, and the README cites
 * it as the place to teach the platform about a new alert type.
 */

export interface AlertGuidance {
  /** Short label rendered next to the alert. */
  headline: string;
  /** What the operator should do, in terms of this platform's controls. */
  action: string;
  /** Which console to act on, when the alert is not raised by that console. */
  console?: string;
}

interface GuidanceRule {
  /** Lower-case substrings of the alert type that select this rule. */
  match: string[];
  service?: string;
  guidance: AlertGuidance;
}

const RULES: GuidanceRule[] = [
  // ----------------------------------------------------------------- RTA ---
  {
    service: "RTA",
    match: ["dish_temperature", "overheat", "temperature_high"],
    guidance: {
      headline: "Dish running hot",
      action:
        "Inspect the dish's system temperature, then request recalibration or disable the dish before the next scan so the array keeps enough operational elements.",
    },
  },
  {
    service: "RTA",
    match: ["availability", "capacity_low", "min_active", "offline"],
    guidance: {
      headline: "Array below minimum capacity",
      action:
        "Check which dishes are offline or disabled in the rack, re-enable serviceable dishes, and defer scans if fewer than three can observe.",
    },
  },
  {
    service: "RTA",
    match: ["wind", "stow", "gust"],
    guidance: {
      headline: "Wind stow",
      action:
        "Scans are suspended while the array is stowed. Watch the wind trend and resume with a scheduled scan once the gust drops below the release threshold.",
    },
  },
  {
    service: "RTA",
    match: ["calibration", "snr", "sensitivity"],
    guidance: {
      headline: "Sensitivity degraded",
      action: "Request recalibration on the dish and re-check SNR on the next scan.",
    },
  },
  {
    service: "RTA",
    match: ["scan", "target", "horizon"],
    guidance: {
      headline: "Scan problem",
      action:
        "Verify the target elevation is above 15°, the band is within 500 MHz – 50 GHz, and that a scan is not already running before restarting.",
    },
  },
  // ----------------------------------------------------------------- MHE ---
  {
    service: "MHE",
    match: ["co2", "air"],
    guidance: {
      headline: "Air quality",
      action:
        "Raise ventilation in the affected room and confirm its environmental systems are enabled; evacuate the room if CO₂ stays above the critical limit.",
    },
  },
  {
    service: "MHE",
    match: ["temperature", "humidity", "climate"],
    guidance: {
      headline: "Climate out of band",
      action:
        "Adjust the room setpoint (285–300 K, 20–80 % RH) and check that environmental systems are enabled and the room is not sealed.",
    },
  },
  {
    service: "MHE",
    match: ["crew", "heart", "spo2", "vital", "wellbeing", "wellness"],
    guidance: {
      headline: "Crew health",
      action:
        "Run a crew wellness check, review the latest survey scores, and escalate to the medical officer if vitals stay out of range.",
    },
  },
  {
    service: "MHE",
    match: ["hydroponics", "irrigation", "water", "nutrient"],
    guidance: {
      headline: "Hydroponics",
      action: "Check the irrigation schedule and water volume for the hydroponics bay.",
    },
  },
  // ----------------------------------------------------------------- OPG ---
  {
    service: "OPG",
    match: ["battery", "soc", "reserve"],
    guidance: {
      headline: "Battery reserve",
      action:
        "Shed non-essential loads and start the diesel generator if the state of charge is still falling towards the reserve threshold.",
    },
  },
  {
    service: "OPG",
    match: ["fuel", "diesel", "generator"],
    guidance: {
      headline: "Diesel plant",
      action:
        "Check the fuel level and generator status; stop the generator before the fuel falls below the safe minimum and shift to solar/battery.",
    },
  },
  {
    service: "OPG",
    match: ["demand", "load", "deficit", "supply"],
    guidance: {
      headline: "Supply shortfall",
      action:
        "Compare generation against demand, change the generation priority, or enable load shedding to protect the reserve.",
    },
  },
  {
    service: "OPG",
    match: ["solar", "inverter", "irradiance"],
    guidance: {
      headline: "Solar array",
      action: "Check inverter status and irradiance; re-enable the array once the fault clears.",
    },
  },
  // ----------------------------------------------------------- platform ---
  {
    match: ["telemetry_lost", "silent", "offline", "no_data"],
    guidance: {
      headline: "Service silent",
      action:
        "The service has stopped publishing. Check the MQTT broker connection for that service; replay still serves the data already captured.",
    },
  },
];

const FALLBACK: AlertGuidance = {
  headline: "Service alert",
  action: "Review the alert cause against the service's current state, then acknowledge and resolve it.",
};

function normalise(alertType: string): string {
  return alertType.toLowerCase();
}

/**
 * Guidance for an alert type. `alertType` is stored as `<type>:<alertId>`, so
 * only the type part is matched.
 */
export function guidanceFor(alertType: string, service?: string): AlertGuidance {
  const type = normalise(alertType.split(":")[0] ?? alertType);
  for (const rule of RULES) {
    if (rule.service && service && rule.service !== service.toUpperCase()) continue;
    if (rule.match.some((token) => type.includes(token))) return rule.guidance;
  }
  // A service-specific rule should still answer even when the caller did not
  // pass a service (replayed alerts, for example).
  for (const rule of RULES) {
    if (rule.match.some((token) => type.includes(token))) return rule.guidance;
  }
  return FALLBACK;
}

/** Severity ordering used to sort the annunciator and pick the header colour. */
export const SEVERITY_RANK: Record<string, number> = {
  critical: 3,
  warning: 2,
  warn: 2,
  info: 1,
};

export function severityRank(severity: string | null | undefined): number {
  if (!severity) return 2;
  return SEVERITY_RANK[severity.toLowerCase()] ?? 2;
}
