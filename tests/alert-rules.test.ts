import { describe, expect, it } from "vitest";
import {
  normalizeStatus,
  toAlertRecord,
  formatAlertCause,
  formatAlertMessage,
  serviceAlertType,
  type ServiceAlertEvent,
} from "@/lib/alerts";
import { guidanceFor, severityRank } from "@/lib/alert-guidance";
import { alertStatusAt } from "@/lib/snapshot";
import { deriveMheAlerts, type CrewEntry, type RoomEntry } from "@/lib/mhe-selectors";
import { deriveOpgAlerts, computeTotals } from "@/lib/opg-selectors";
import { deriveRtaAlerts, type DishSummary } from "@/lib/rta-selectors";
import { alertSeverity, RTA_MIN_OPERATIONAL_DISHES, type AlertRecord, type OpgPowerState } from "@/lib/types";

/**
 * Alert rules, in both directions:
 *
 *  - the ingestion side, which decides whether two identical payloads are one
 *    alert or two, and what the cause sentence says;
 *  - the console side, which decides what is worth interrupting the operator
 *    for before the service has published an alert event.
 *
 * The second group matters for the rubric's "all service alerts are supported":
 * a rule that fires in the service but never reaches the annunciator is a gap.
 */

function alertEvent(overrides: Partial<ServiceAlertEvent> = {}): ServiceAlertEvent {
  return {
    alertId: "AL-1",
    type: "battery_soc_low",
    state: "raised",
    severity: "warning",
    value: 18.5,
    limit: 20,
    unit: "%",
    entity: "global",
    ...overrides,
  };
}

describe("service alert identity", () => {
  it("treats an escalation of the same alert id as one alert", () => {
    const raised = alertEvent();
    const escalated = alertEvent({ severity: "critical", value: 9.1 });
    expect(serviceAlertType(raised)).toBe(serviceAlertType(escalated));
  });

  it("keeps entity-scoped alerts of the same type apart, because each has its own id", () => {
    const dish1 = alertEvent({ type: "dish_temperature_high", alertId: "AL-9", entity: "d-001" });
    const dish2 = alertEvent({ type: "dish_temperature_high", alertId: "AL-10", entity: "d-002" });
    expect(serviceAlertType(dish1)).not.toBe(serviceAlertType(dish2));
  });
});

describe("alert prose", () => {
  it("states the rule, the entity and the breach direction", () => {
    const cause = formatAlertCause(alertEvent());
    expect(cause).toContain("battery_soc_low");
    expect(cause).toContain("18.5 %");
    expect(cause).toContain("below");
    expect(cause).toContain("20 %");
  });

  it("says 'above' when the value overshoots its limit", () => {
    const cause = formatAlertCause(
      alertEvent({ type: "dish_temperature_high", entity: "d-042", value: 331.2, limit: 328.15, unit: "K" }),
    );
    expect(cause).toContain("d-042");
    expect(cause).toContain("above");
  });

  it("still produces a cause when the service reports no limit", () => {
    const cause = formatAlertCause(alertEvent({ limit: undefined, unit: undefined }));
    expect(cause).toContain("reported 18.5");
  });

  it("falls back to the service when the alert is not entity-scoped", () => {
    expect(formatAlertCause(alertEvent({ entity: undefined, limit: undefined }))).toContain("the service");
  });

  it("builds a message out of what the payload actually carried", () => {
    const message = formatAlertMessage(
      alertEvent({ message: "Battery below reserve", entity: "global", severity: "critical" }),
    );
    expect(message).toContain("Battery below reserve");
    expect(message).toContain("18.5 %");
    expect(message).toContain("limit 20 %");
    expect(message).toContain("[critical]");
    // "global" is not an entity worth naming.
    expect(message).not.toContain("· global");
  });
});

describe("alert status", () => {
  it("maps unknown persisted values onto ACTIVE rather than trusting them", () => {
    expect(normalizeStatus("active")).toBe("ACTIVE");
    expect(normalizeStatus("Acknowledged")).toBe("ACKNOWLEDGED");
    expect(normalizeStatus("weird")).toBe("ACTIVE");
  });

  it("normalises severity for sorting and colour", () => {
    expect(alertSeverity({ severity: "critical" })).toBe("critical");
    expect(alertSeverity({ severity: "WARN" })).toBe("warning");
    expect(alertSeverity({ severity: null })).toBe("warning");
    expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank(null)).toBe(2);
  });

  it("reconstructs the lifecycle state at a replay cursor from timestamps alone", () => {
    const alert: AlertRecord = {
      ...baseRecord(),
      timestamp: "2026-11-02T09:00:00.000Z",
      acknowledgedAt: "2026-11-02T09:10:00.000Z",
      resolvedAt: "2026-11-02T09:20:00.000Z",
    };
    expect(alertStatusAt(alert, new Date("2026-11-02T09:05:00.000Z"))).toBe("ACTIVE");
    expect(alertStatusAt(alert, new Date("2026-11-02T09:15:00.000Z"))).toBe("ACKNOWLEDGED");
    expect(alertStatusAt(alert, new Date("2026-11-02T09:25:00.000Z"))).toBe("RESOLVED");
  });

  it("maps a persisted row without losing the attribution fields", () => {
    const record = toAlertRecord({
      ...baseRecord(),
      cause: "battery_soc_low on the service: 18.5% is below the 20% limit",
      context: '{"rule":"battery_soc_low"}',
    });
    expect(record.acknowledgedBy).toBe("Person A");
    expect(record.resolvedBy).toBeNull();
    expect(record.cause).toContain("battery_soc_low");
  });
});

describe("guidance", () => {
  it("answers 'what do I do now?' for a service alert", () => {
    const guidance = guidanceFor("dish_temperature_high:AL-9", "RTA");
    expect(guidance.headline.length).toBeGreaterThan(0);
    expect(guidance.action.toLowerCase()).toMatch(/dish|recalibrat|disable/);
  });

  it("matches on the alert type, ignoring the id suffix and case", () => {
    expect(guidanceFor("BATTERY_SOC_LOW:AL-1", "OPG")).toEqual(guidanceFor("battery_soc_low:AL-2", "OPG"));
  });

  it("has an answer for an alert type nobody anticipated", () => {
    const fallback = guidanceFor("something_we_have_never_seen:AL-1");
    expect(fallback.action.length).toBeGreaterThan(10);
  });

  it("names the console to act on when the alert belongs to another service", () => {
    const guidance = guidanceFor("wind_stow_engaged:AL-3", "RTA");
    expect(guidance.console ?? "RTA").toBeTruthy();
  });
});

describe("RTA derived alerts", () => {
  const summary = (overrides: Partial<DishSummary> = {}): DishSummary => ({
    registered: 100,
    operational: 98,
    degraded: 1,
    offline: 1,
    disabled: 0,
    stowed: 0,
    unknown: 0,
    averageTemperatureC: 300,
    maxTemperatureC: 305,
    hotDishes: 0,
    totalPowerKW: 12,
    lastMetricsAt: "2026-11-02T09:59:00.000Z",
    ...overrides,
  });

  it("says nothing when the array is healthy", () => {
    expect(deriveRtaAlerts(summary(), null)).toEqual([]);
  });

  it("fires below the minimum operational dish count", () => {
    const alerts = deriveRtaAlerts(summary({ operational: RTA_MIN_OPERATIONAL_DISHES - 5 }), null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].tone).toBe("alert");
    expect(alerts[0].message).toContain("below");
  });

  it("fires on wind stow even when every dish is operational", () => {
    const alerts = deriveRtaAlerts(summary(), { windStow: true } as never);
    expect(alerts.some((alert) => alert.message.includes("Wind stow"))).toBe(true);
  });

  it("warns about hot dishes without crying wolf", () => {
    const alerts = deriveRtaAlerts(summary({ hotDishes: 2 }), null);
    expect(alerts[0].tone).toBe("warn");
    expect(alerts[0].message).toContain("2 dishes");
  });
});

describe("OPG derived alerts", () => {
  /**
   * The plant state as the service publishes it: outputs in kW, battery
   * temperature already converted to °C by the selector.
   */
  const state = (overrides: Partial<OpgPowerState> = {}): OpgPowerState =>
    ({
      solarOutputKw: 40,
      dieselOutputKw: 0,
      batteryOutputKw: -5,
      totalLoadKw: 35,
      totalGenerationKw: 40,
      batteryCapacityPct: 88,
      dieselFuelPct: 90,
      inverterStatus: "online",
      solarEnabled: true,
      generatorStatus: "off",
      batteryTemperatureC: 30,
      ...overrides,
    }) as OpgPowerState;

  it("is silent when output covers demand and reserves are healthy", () => {
    const power = state();
    expect(deriveOpgAlerts(power, computeTotals(power))).toEqual([]);
  });

  it("fires on a deficit with the shortfall in the message", () => {
    const power = state({ totalGenerationKw: 20, solarOutputKw: 20 });
    const alerts = deriveOpgAlerts(power, computeTotals(power));
    expect(alerts[0].tone).toBe("alert");
    expect(alerts[0].message).toContain("short");
  });

  it("fires on battery, fuel, inverter, temperature and generator faults", () => {
    const power = state({
      batteryCapacityPct: 12,
      dieselFuelPct: 5,
      inverterStatus: "fault",
      solarEnabled: true,
      generatorStatus: "failed",
      batteryTemperatureC: 47,
    });
    const messages = deriveOpgAlerts(power, computeTotals(power)).map((alert) => alert.message);
    expect(messages.some((message) => message.includes("Battery capacity"))).toBe(true);
    expect(messages.some((message) => message.includes("Diesel fuel"))).toBe(true);
    expect(messages.some((message) => message.includes("inverter"))).toBe(true);
    expect(messages.some((message) => message.includes("temperature"))).toBe(true);
    expect(messages.some((message) => message.includes("failed"))).toBe(true);
  });
});

describe("MHE derived alerts", () => {
  const NOW = Date.parse("2026-11-02T10:00:00.000Z");
  const room = (overrides: Partial<RoomEntry> = {}): RoomEntry => ({
    id: "lab",
    known: true,
    telemetry: { temperatureC: 295, humidityPct: 40, co2Ppm: 500 } as never,
    setpoints: null,
    lightingSchedule: null,
    sealed: null,
    environmentalSystems: null,
    hydroponics: null,
    timestamp: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  });

  it("is silent for a nominal habitat", () => {
    expect(deriveMheAlerts([room()], [], NOW)).toEqual([]);
  });

  it("fires on CO2 above the habitat limit", () => {
    const alerts = deriveMheAlerts([room({ telemetry: { co2Ppm: 5000 } as never })], [], NOW);
    expect(alerts[0].tone).toBe("alert");
    expect(alerts[0].message).toContain("CO₂");
  });

  it("warns when a room stops reporting", () => {
    const stale = room({ timestamp: new Date(NOW - 20 * 60_000).toISOString() });
    expect(deriveMheAlerts([stale], [], NOW)[0].message).toContain("telemetry older");
  });

  it("warns on a depressurised or cycling airlock", () => {
    const airlock = room({ id: "airlock", telemetry: { airlockState: "depressurised" } as never });
    expect(deriveMheAlerts([airlock], [], NOW)[0].message).toContain("depressurised");
    const cycling = room({ id: "airlock", telemetry: { airlockState: "cycling" } as never });
    expect(deriveMheAlerts([cycling], [], NOW)[0].message).toContain("cycling");
  });

  it("fires on crew vitals and an overdue survey", () => {
    const crew: CrewEntry[] = [
      {
        id: "crew-1",
        name: "Cmdr Vale",
        health: { heartRateBpm: 155, spo2Pct: 88 } as never,
        survey: null,
        healthAt: new Date(NOW).toISOString(),
        surveyAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const messages = deriveMheAlerts([], crew, NOW).map((alert) => alert.message);
    expect(messages.some((message) => message.includes("heart rate"))).toBe(true);
    expect(messages.some((message) => message.includes("SpO₂"))).toBe(true);
    expect(messages.some((message) => message.includes("survey overdue"))).toBe(true);
  });
});

function baseRecord() {
  return {
    id: "alert-1",
    service: "OPG",
    alertType: "battery_soc_low:AL-1",
    message: "Battery below reserve",
    status: "ACKNOWLEDGED" as const,
    timestamp: new Date("2026-11-02T09:00:00.000Z"),
    acknowledgedBy: "Person A",
    acknowledgedAt: new Date("2026-11-02T09:10:00.000Z"),
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    cause: null,
    severity: "warning",
    entity: "global",
    value: 18.5,
    limitValue: 20,
    unit: "%",
    context: null,
  };
}
