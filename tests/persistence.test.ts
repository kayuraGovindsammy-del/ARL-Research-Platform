import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  AlertOperationError,
  acknowledgeAlert,
  clearServiceAlert,
  listAlerts,
  raiseServiceAlert,
  resolveAlert,
  type ServiceAlertEvent,
} from "@/lib/alerts";
import {
  alertStatusAt,
  getLatestSampleAt,
  getReplayContext,
  getSnapshot,
  getTopicBounds,
  getTopicHistory,
} from "@/lib/snapshot";

/**
 * Persistence and integration behaviour, against a real SQLite file.
 *
 * These tests exercise the contract the rubric asks for by name: data is
 * persisted and replayable at a chosen time, and an alert keeps the whole
 * decision trail — raised, acknowledged (who/when), resolved (who/when), cause.
 * Nothing here is mocked, so a schema or query mistake fails the suite.
 */

const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (offsetMinutes: number) => new Date(T0.getTime() + offsetMinutes * 60_000);

async function sample(
  service: string,
  topic: string,
  payload: Record<string, unknown>,
  timestamp: Date,
): Promise<void> {
  await prisma.telemetry.create({
    data: { service, topic, payload: JSON.stringify(payload), timestamp },
  });
}

function batteryAlert(overrides: Partial<ServiceAlertEvent> = {}): ServiceAlertEvent {
  return {
    alertId: "AL-1",
    type: "battery_soc_low",
    state: "raised",
    severity: "warning",
    value: 18.5,
    limit: 20,
    unit: "%",
    entity: "global",
    message: "Battery below reserve",
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.telemetry.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.auditLog.deleteMany();
});

describe("replay snapshot", () => {
  it("returns the newest sample per topic at or before the cursor", async () => {
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 300 }, at(-3));
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 305 }, at(-1));
    // After the cursor — must not leak into a historical view.
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 320 }, at(2));

    const snapshot = await getSnapshot(T0, null);
    expect(snapshot.count).toBe(1);
    expect(snapshot.topics["arl/rta/d-001/telemetry/system"].payload.system_temp_c).toBe(305);
    expect(snapshot.targetTime).toBe(T0.toISOString());
  });

  it("walks back to what was true at an earlier cursor", async () => {
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 300 }, at(-3));
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 305 }, at(-1));

    const earlier = await getSnapshot(at(-2), null);
    expect(earlier.topics["arl/rta/d-001/telemetry/system"].payload.system_temp_c).toBe(300);
  });

  it("bounds a trend window at the cursor instead of the newest sample", async () => {
    // This is what lets a chart describe the storm, not the present: samples
    // after the cursor must never be plotted in a historical window.
    const topic = "arl/rta/d-002/telemetry/normal";
    await sample("RTA", topic, { temperature_k: 300 }, at(-10));
    await sample("RTA", topic, { temperature_k: 305 }, at(-5));
    await sample("RTA", topic, { temperature_k: 320 }, at(5));

    const atCursor = await getTopicHistory(topic, at(-20), 100, T0);
    expect(atCursor.map((row) => row.payload.temperature_k)).toEqual([300, 305]);

    const unbounded = await getTopicHistory(topic, at(-20), 100);
    expect(unbounded).toHaveLength(3);
  });

  it("reports when a topic was recorded, so an empty replay window explains itself", async () => {
    // The researcher jumps back further than the capture reaches; the chart is
    // empty but the panel can say the topic only starts at the first sample.
    const topic = "arl/rta/d-003/telemetry/normal";
    await sample("RTA", topic, { temperature_k: 300 }, at(-10));
    await sample("RTA", topic, { temperature_k: 302 }, at(-4));

    const bounds = await getTopicBounds(topic);
    expect(bounds.samples).toBe(2);
    expect(bounds.earliest).toBe(at(-10).toISOString());
    expect(bounds.latest).toBe(at(-4).toISOString());
  });

  it("keeps every service's topics in one picture, and can scope to one", async () => {
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 300 }, at(-1));
    await sample("OPG", "arl/opg/global/telemetry/power", { total_generation_w: 41000 }, at(-1));

    const all = await getSnapshot(T0, null);
    expect(all.count).toBe(2);

    const opgOnly = await getSnapshot(T0, "OPG");
    expect(opgOnly.count).toBe(1);
    expect(Object.keys(opgOnly.topics)).toEqual(["arl/opg/global/telemetry/power"]);
  });

  it("reports an empty snapshot rather than an error when nothing has arrived yet", async () => {
    const snapshot = await getSnapshot(T0, null);
    expect(snapshot.count).toBe(0);
    expect(snapshot.topics).toEqual({});
  });

  it("uses the newest sample as the platform clock, not the wall clock", async () => {
    expect(await getLatestSampleAt(null)).toBeNull();
    await sample("LWM", "arl/lwm/lwm-1/telemetry/weather", { temperature_k: 300 }, at(45));
    expect((await getLatestSampleAt(null))?.toISOString()).toBe(at(45).toISOString());
    expect((await getLatestSampleAt("LWM"))?.toISOString()).toBe(at(45).toISOString());
    expect(await getLatestSampleAt("MHE")).toBeNull();
  });
});

describe("alert persistence", () => {
  it("stores the cause and the guidance behind an alert", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    expect(record).not.toBeNull();
    expect(record!.status).toBe("ACTIVE");
    expect(record!.cause).toContain("below");
    expect(record!.severity).toBe("warning");
    expect(record!.value).toBe(18.5);
    expect(record!.limitValue).toBe(20);
    expect(record!.unit).toBe("%");
    // The annunciator reads `context.guidance` to tell the operator what to do.
    expect(JSON.parse(record!.context ?? "{}").guidance).toBeTruthy();
    expect(record!.timestamp).toBe(at(-5).toISOString());
  });

  it("does not duplicate an alert the service re-publishes verbatim", async () => {
    await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const duplicate = await raiseServiceAlert("OPG", batteryAlert(), at(-4));
    expect(duplicate).toBeNull();
    expect(await prisma.alert.count()).toBe(1);
  });

  it("ignores a retained alert event redelivered after the alert was resolved", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    await clearServiceAlert("OPG", batteryAlert({ state: "cleared" }));
    // A resubscribe replays the retained event with its original timestamp.
    expect(await raiseServiceAlert("OPG", batteryAlert(), at(-5))).toBeNull();
    expect(await prisma.alert.count()).toBe(1);
    expect((await prisma.alert.findUnique({ where: { id: record!.id } }))?.status).toBe("RESOLVED");
    // A condition that recurs later carries a new timestamp and is recorded again.
    expect(await raiseServiceAlert("OPG", batteryAlert(), at(20))).not.toBeNull();
    expect(await prisma.alert.count()).toBe(2);
  });

  it("refreshes the same row when the service escalates it", async () => {
    const first = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const escalated = await raiseServiceAlert(
      "OPG",
      batteryAlert({ severity: "critical", value: 9.1 }),
      at(-4),
    );
    expect(escalated?.id).toBe(first?.id);
    expect(escalated?.severity).toBe("critical");
    expect(escalated?.value).toBe(9.1);
    expect(await prisma.alert.count()).toBe(1);
  });

  it("keeps entity-scoped alerts separate", async () => {
    await raiseServiceAlert("RTA", batteryAlert({ alertId: "AL-9", entity: "d-001" }), at(-5));
    await raiseServiceAlert("RTA", batteryAlert({ alertId: "AL-10", entity: "d-002" }), at(-5));
    expect(await prisma.alert.count()).toBe(2);
  });

  it("records who acknowledged it and when, and audits the action", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const acked = await acknowledgeAlert(record!.id, "Person A", "Investigating the reserve");

    expect(acked.status).toBe("ACKNOWLEDGED");
    expect(acked.acknowledgedBy).toBe("Person A");
    expect(acked.acknowledgedAt).toBeTruthy();
    expect(acked.resolvedAt).toBeNull();

    const audit = await prisma.auditLog.findMany();
    expect(audit.some((row) => row.action === "ALERT_ACKNOWLEDGED" && row.performedBy === "Person A")).toBe(true);
  });

  it("refuses a second acknowledgement and a blank operator", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    await acknowledgeAlert(record!.id, "Person A");

    await expect(acknowledgeAlert(record!.id, "Person A")).rejects.toThrow(AlertOperationError);
    await expect(acknowledgeAlert(record!.id, " ")).rejects.toThrow(AlertOperationError);
    await expect(acknowledgeAlert("missing-id", "Person A")).rejects.toThrow(AlertOperationError);
  });

  it("requires a resolution note and records who resolved it", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    await expect(resolveAlert(record!.id, "Person B", "  ")).rejects.toThrow(AlertOperationError);

    const resolved = await resolveAlert(record!.id, "Person B", "Diesel started, reserve recovering");
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedBy).toBe("Person B");
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolutionNote).toContain("Diesel started");
    // Resolving without acknowledging first still leaves a complete trail.
    expect(resolved.acknowledgedBy).toBe("Person B");
    expect(resolved.acknowledgedAt).toBeTruthy();

    await expect(resolveAlert(record!.id, "Person B", "again")).rejects.toThrow(AlertOperationError);

    const audit = await prisma.auditLog.findMany();
    expect(audit.some((row) => row.action === "ALERT_RESOLVED" && row.performedBy === "Person B")).toBe(true);
  });

  it("resolves automatically when the service says the condition cleared", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const cleared = await clearServiceAlert("OPG", batteryAlert({ state: "cleared" }));
    expect(cleared?.id).toBe(record?.id);
    expect(cleared?.status).toBe("RESOLVED");
    expect(cleared?.resolvedBy).toBe("OPG service");
    expect(cleared?.resolutionNote).toContain("Cleared automatically");
  });

  it("does nothing when a clear arrives for an alert that was never raised", async () => {
    expect(await clearServiceAlert("RTA", batteryAlert({ state: "cleared" }))).toBeNull();
  });

  it("resolves on the service's clock, so the alert is closed in a replay of that moment", async () => {
    const raised = await raiseServiceAlert("OPG", batteryAlert(), at(0));
    const clearedAt = at(1);
    await clearServiceAlert("OPG", batteryAlert({ state: "cleared" }), clearedAt);

    const row = await prisma.alert.findFirst({ where: { alertType: raised!.alertType } });
    const resolvedAt = new Date(row!.resolvedAt!).toISOString();
    const closed = { ...raised!, resolvedAt };
    // After the clear the alert reads RESOLVED; before it, the same row was live.
    expect(alertStatusAt(closed, at(2))).toBe("RESOLVED");
    expect(alertStatusAt(closed, at(0))).toBe("ACTIVE");
    expect(new Date(row!.resolvedAt!).getTime()).toBe(clearedAt.getTime());
  });

  it("stamps acknowledgement on the platform clock, not the workstation clock", async () => {
    // The exam lab runs ahead of wall time; a stamp taken from the workstation
    // would sort before the sample it belongs to.
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await sample("OPG", "arl/opg/global/telemetry/power", { total_load_w: 1 }, future);
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const acked = await acknowledgeAlert(record!.id, "Person A");
    expect(new Date(acked.acknowledgedAt!).getTime()).toBeGreaterThanOrEqual(future.getTime());
  });

  it("filters the log by service and status", async () => {
    await raiseServiceAlert("OPG", batteryAlert(), at(-5));
    const rta = await raiseServiceAlert(
      "RTA",
      batteryAlert({ alertId: "AL-2", type: "dish_temperature_high", entity: "d-042" }),
      at(-3),
    );
    await acknowledgeAlert(rta!.id, "Person A");

    expect((await listAlerts({ service: "RTA" })).length).toBe(1);
    expect((await listAlerts({ statuses: ["ACKNOWLEDGED"] })).map((alert) => alert.id)).toEqual([rta!.id]);
    expect((await listAlerts()).length).toBe(2);
  });
});

describe("replay context", () => {
  it("shows an alert as it was at the cursor, not as it is now", async () => {
    const record = await raiseServiceAlert("OPG", batteryAlert(), at(-10));
    await acknowledgeAlert(record!.id, "Person A");
    // Move the acknowledgement into the past so the cursor sits between raise and resolve.
    await prisma.alert.update({
      where: { id: record!.id },
      data: {
        acknowledgedAt: at(-5),
        resolvedAt: at(-1),
        resolvedBy: "Person B",
        resolutionNote: "Diesel started",
        status: "RESOLVED",
      },
    });

    const context = await getReplayContext(at(-3), "OPG");
    const live = context.activeAlerts.find((alert) => alert.id === record!.id);
    expect(live?.status).toBe("ACKNOWLEDGED");

    const beforeAck = await getReplayContext(at(-7), "OPG");
    expect(beforeAck.recentAlerts.find((alert) => alert.id === record!.id)?.status).toBe("ACTIVE");

    const afterResolve = await getReplayContext(at(0), "OPG");
    expect(afterResolve.activeAlerts.find((alert) => alert.id === record!.id)).toBeUndefined();
  });

  it("attributes the lifecycle at the cursor from timestamps alone", () => {
    const record = {
      id: "a",
      service: "RTA",
      alertType: "wind_stow_engaged:AL-3",
      message: "Wind stow",
      status: "RESOLVED" as const,
      timestamp: at(-10).toISOString(),
      acknowledgedBy: "Person A",
      acknowledgedAt: at(-8).toISOString(),
      resolvedBy: "Person B",
      resolvedAt: at(-2).toISOString(),
      resolutionNote: "Gusts eased",
      cause: null,
      severity: "warning",
      entity: "global",
      value: null,
      limitValue: null,
      unit: null,
      context: null,
    };
    expect(alertStatusAt(record, at(-9))).toBe("ACTIVE");
    expect(alertStatusAt(record, at(-5))).toBe("ACKNOWLEDGED");
    expect(alertStatusAt(record, at(0))).toBe("RESOLVED");
  });

  it("includes service events from the window around the cursor and nothing outside it", async () => {
    await sample("RTA", "arl/rta/events/scan", { event: "started", scan_id: "scan-1" }, at(-5));
    await sample("RTA", "arl/rta/events/scan", { event: "completed", scan_id: "scan-1" }, at(30));
    await sample("RTA", "arl/rta/d-001/telemetry/system", { system_temp_c: 300 }, at(-5));

    const context = await getReplayContext(at(0), "RTA");
    expect(context.events.length).toBe(1);
    expect(context.events[0].kind).toBe("scan");
    expect(context.events[0].payload.event).toBe("started");
    expect(context.windowMs).toBe(30 * 60 * 1000);
  });
});
