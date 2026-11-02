import { describe, expect, it } from "vitest";
import {
  ackTopic,
  commandTopic,
  eventTopic,
  parseTopic,
  stateAt,
  stateValue,
  telemetryTopic,
  telemetryWildcard,
  topicMatches,
} from "@/lib/topics";

/**
 * Topic parsing is the first place a payload can be silently lost: if the
 * taxonomy is misread, a dish sample lands under the wrong stream and replay
 * shows a gap that never happened. These cases are the shapes the live lab
 * actually publishes.
 */
describe("parseTopic", () => {
  it("reads a telemetry sample", () => {
    const parsed = parseTopic("arl/rta/d-042/telemetry/system");
    expect(parsed.service).toBe("RTA");
    expect(parsed.kind).toBe("telemetry");
    expect(parsed.entity).toBe("d-042");
    expect(parsed.name).toBe("system");
  });

  it("anchors on the service segment, so a custom prefix needs no client change", () => {
    const parsed = parseTopic("exam-2026/arl/opg/global/telemetry/power");
    expect(parsed.service).toBe("OPG");
    expect(parsed.kind).toBe("telemetry");
    expect(parsed.entity).toBe("global");
    expect(parsed.name).toBe("power");
  });

  it("accepts upper-case service segments", () => {
    expect(parseTopic("arl/MHE/habitat/telemetry/air").service).toBe("MHE");
  });

  it("reads the retained topology document", () => {
    const parsed = parseTopic("arl/lwm/$topology");
    expect(parsed.service).toBe("LWM");
    expect(parsed.kind).toBe("topology");
    expect(parsed.name).toBe("$topology");
  });

  it("reads service events", () => {
    const parsed = parseTopic("arl/rta/events/alert");
    expect(parsed.kind).toBe("event");
    expect(parsed.name).toBe("alert");
    // Events are service-scoped, not entity-scoped.
    expect(parsed.entity).toBeNull();
  });

  it("reads commands we publish and the acks that come back", () => {
    const command = parseTopic("arl/opg/cmd/diesel-1/start");
    expect(command.kind).toBe("command");
    expect(command.entity).toBe("diesel-1");
    expect(command.name).toBe("start");

    const ack = parseTopic("arl/opg/ack/2f1c-uuid");
    expect(ack.kind).toBe("ack");
    expect(ack.name).toBe("2f1c-uuid");
  });

  it("reads retained state items", () => {
    const parsed = parseTopic("arl/lwm/lwm-4/state/position");
    expect(parsed.kind).toBe("state");
    expect(parsed.entity).toBe("lwm-4");
    expect(parsed.name).toBe("position");
  });

  it("keeps an unknown-but-service-scoped topic rather than dropping it", () => {
    const parsed = parseTopic("arl/rta/d-042/telemetry");
    expect(parsed.service).toBe("RTA");
    expect(parsed.kind).toBe("unknown");
  });

  it("returns an empty parse for a topic with no known service", () => {
    const parsed = parseTopic("sensors/roof/temperature");
    expect(parsed.service).toBeNull();
    expect(parsed.kind).toBe("unknown");
    expect(parsed.entity).toBeNull();
  });

  it("tolerates leading, trailing and doubled separators", () => {
    const parsed = parseTopic("/arl//opg/global/telemetry/power/");
    expect(parsed.service).toBe("OPG");
    expect(parsed.entity).toBe("global");
  });
});

describe("topic builders and filters", () => {
  it("builds the command and ack topics the worker subscribes to", () => {
    expect(commandTopic("arl", "MHE", "crew-1", "wellness_check")).toBe(
      "arl/mhe/cmd/crew-1/wellness_check",
    );
    expect(ackTopic("arl", "RTA", "cmd-9")).toBe("arl/rta/ack/cmd-9");
    expect(telemetryWildcard("arl")).toBe("arl/#");
    expect(telemetryTopic("arl", "LWM", "lwm-3", "weather")).toBe("arl/lwm/lwm-3/telemetry/weather");
    expect(eventTopic("arl", "OPG", "refuel")).toBe("arl/opg/events/refuel");
  });

  it("matches single-level wildcards only", () => {
    expect(topicMatches("arl/rta/d-1/telemetry/scan", "arl/rta/+/telemetry/scan")).toBe(true);
    expect(topicMatches("arl/rta/d-1/telemetry/scan", "arl/rta/+/telemetry/+")).toBe(true);
    expect(topicMatches("arl/rta/d-1/telemetry/scan", "arl/rta/+/telemetry")).toBe(false);
    expect(topicMatches("arl/rta/d-1/telemetry/scan", "arl/mhe/+/telemetry/scan")).toBe(false);
  });
});

describe("state lookups", () => {
  const topics = {
    "arl/rta/main/state/scan_state": { payload: { value: "SCANNING" }, timestamp: "2026-11-02T09:00:00.000Z" },
    "arl/lwm/lwm-4/state/enabled": { payload: { value: true }, timestamp: "2026-11-02T09:01:00.000Z" },
  };

  it("reads the value of a retained state item", () => {
    expect(stateValue(topics, "rta", "main", "scan_state")).toBe("SCANNING");
    expect(stateValue(topics, "lwm", "lwm-4", "enabled")).toBe(true);
  });

  it("returns undefined rather than throwing for an item that never arrived", () => {
    expect(stateValue(topics, "opg", "global", "load_shed")).toBeUndefined();
  });

  it("reads the timestamp of a retained state item", () => {
    expect(stateAt(topics, "lwm", "lwm-4", "enabled")).toBe("2026-11-02T09:01:00.000Z");
    expect(stateAt(topics, "lwm", "lwm-9", "enabled")).toBeNull();
  });
});
