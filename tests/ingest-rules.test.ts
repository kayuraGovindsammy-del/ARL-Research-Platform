import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  RETENTION_MS,
  parsePayload,
  resolveTimestamp,
  str,
  toAlertEvent,
  toScanContext,
} from "@/lib/ingest-rules";

const NOW = new Date("2026-11-02T10:00:00.000Z");

describe("parsePayload", () => {
  it("keeps a JSON object as-is", () => {
    const payload = parsePayload(
      Buffer.from('{"dish_id":"d-042","system_temp_c":301.4,"ts":1762082400000}'),
    );
    expect(payload).toEqual({ dish_id: "d-042", system_temp_c: 301.4, ts: 1762082400000 });
  });

  it("wraps a bare scalar so a single-value topic still has a payload", () => {
    expect(parsePayload(Buffer.from("301.4"))).toEqual({ value: 301.4 });
    expect(parsePayload(Buffer.from('"ONLINE"'))).toEqual({ value: "ONLINE" });
  });

  it("wraps an array, which is not a record we can address", () => {
    expect(parsePayload(Buffer.from("[1,2,3]"))).toEqual({ value: [1, 2, 3] });
  });

  it("keeps non-JSON text as raw, because a plain sample is still replayable", () => {
    expect(parsePayload(Buffer.from("  ESTOP ENGAGED  "))).toEqual({ raw: "ESTOP ENGAGED" });
  });

  it("treats an empty body as an empty record", () => {
    expect(parsePayload(Buffer.from("   "))).toEqual({});
  });

  it("drops a payload above the size bound instead of writing it to SQLite", () => {
    const oversized = Buffer.alloc(MAX_PAYLOAD_BYTES + 1, "a");
    expect(parsePayload(oversized)).toBeNull();
  });
});

describe("resolveTimestamp", () => {
  it("honours the service clock in epoch milliseconds", () => {
    const ts = NOW.getTime() - 5_000;
    expect(resolveTimestamp({ ts }, NOW).toISOString()).toBe(new Date(ts).toISOString());
  });

  it("accepts epoch seconds, which the older services still publish", () => {
    const seconds = Math.floor(NOW.getTime() / 1000) - 30;
    expect(resolveTimestamp({ ts: seconds }, NOW).toISOString()).toBe(
      new Date(seconds * 1000).toISOString(),
    );
  });

  it("accepts an ISO string", () => {
    expect(resolveTimestamp({ timestamp: "2026-11-02T09:59:00.000Z" }, NOW).toISOString()).toBe(
      "2026-11-02T09:59:00.000Z",
    );
  });

  it("re-stamps a timestamp far outside the retention window, so a bad clock cannot poison replay", () => {
    const ancient = NOW.getTime() - RETENTION_MS - 60_000;
    expect(resolveTimestamp({ ts: ancient }, NOW).toISOString()).toBe(NOW.toISOString());
    expect(resolveTimestamp({ ts: "not-a-date" }, NOW).toISOString()).toBe(NOW.toISOString());
    expect(resolveTimestamp({}, NOW).toISOString()).toBe(NOW.toISOString());
  });

  it("rejects non-finite numbers", () => {
    expect(resolveTimestamp({ ts: Number.NaN }, NOW).toISOString()).toBe(NOW.toISOString());
  });
});

describe("toAlertEvent", () => {
  const base = {
    alert_id: "AL-77",
    type: "dish_temperature_high",
    state: "raised",
    severity: "critical",
    value: 331.2,
    limit: 328.15,
    unit: "K",
    message: "Dish envelope above limit",
    entity: "d-042",
    metadata: { dish_id: "d-042" },
  };

  it("maps a complete service alert", () => {
    expect(toAlertEvent(base)).toEqual({
      alertId: "AL-77",
      type: "dish_temperature_high",
      state: "raised",
      severity: "critical",
      value: 331.2,
      limit: 328.15,
      unit: "K",
      message: "Dish envelope above limit",
      entity: "d-042",
      metadata: { dish_id: "d-042" },
    });
  });

  it("rejects an alert missing the fields that make it actionable", () => {
    expect(toAlertEvent({ ...base, alert_id: undefined })).toBeNull();
    expect(toAlertEvent({ ...base, type: "" })).toBeNull();
    expect(toAlertEvent({ ...base, state: undefined })).toBeNull();
  });

  it("defaults an unknown severity to warning rather than trusting the payload", () => {
    const event = toAlertEvent({ ...base, severity: undefined });
    expect(event?.severity).toBe("warning");
  });

  it("drops metadata that is not an object", () => {
    expect(toAlertEvent({ ...base, metadata: ["d-042"] })?.metadata).toBeUndefined();
    expect(toAlertEvent({ ...base, metadata: "d-042" })?.metadata).toBeUndefined();
  });
});

describe("toScanContext", () => {
  const started = {
    event: "started",
    scan_id: "scan-1",
    ra_rad: 1.2,
    dec_rad: -0.4,
    fov_rad: 0.02,
    band_hz: 1_420_405_751,
    grid_size: 64,
    overlap: 3,
    dishes: ["d-001", 42],
    expected_duration_s: 120,
    origin: "command",
    target: "Sgr A*",
  };

  it("captures the geometry the scan canvas needs to decode samples", () => {
    const context = toScanContext(started, NOW);
    expect(context).toMatchObject({
      scanId: "scan-1",
      raRad: 1.2,
      decRad: -0.4,
      fovRad: 0.02,
      bandHz: 1_420_405_751,
      gridSize: 64,
      overlap: 3,
      dishes: ["d-001", "42"],
      expectedDurationS: 120,
      startedAt: NOW.toISOString(),
    });
    expect(context?.target).toContain("Sgr");
  });

  it("ignores progress and terminal events for the same scan", () => {
    expect(toScanContext({ ...started, event: "progress" }, NOW)).toBeNull();
    expect(toScanContext({ ...started, event: "completed" }, NOW)).toBeNull();
  });

  it("refuses a started event without a decodable grid", () => {
    expect(toScanContext({ ...started, fov_rad: undefined }, NOW)).toBeNull();
    expect(toScanContext({ ...started, scan_id: "" }, NOW)).toBeNull();
  });

  it("defaults the optional grid parameters", () => {
    const context = toScanContext(
      { event: "started", scan_id: "scan-2", ra_rad: 0, dec_rad: 0, fov_rad: 0.01 },
      NOW,
    );
    expect(context?.gridSize).toBe(128);
    expect(context?.overlap).toBe(3);
    expect(context?.dishes).toEqual([]);
    expect(context?.origin).toBe("command");
  });
});

describe("str", () => {
  it("trims and rejects blank strings", () => {
    expect(str("  ONLINE ")).toBe("ONLINE");
    expect(str("   ")).toBeNull();
    expect(str(42)).toBeNull();
  });
});
