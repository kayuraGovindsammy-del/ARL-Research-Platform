import { describe, expect, it } from "vitest";
import { CONTROLS, controlsFor, getControl, validateControlValue } from "@/lib/controls";
import { PRESETS, presetNeedsSelection, presetsFor } from "@/lib/presets";
import { CONSOLE_SERVICES } from "@/lib/types";

/**
 * Architecture and Control, tested as invariants rather than by inspection.
 *
 * The consoles, the presets and the command API all read the same catalogue.
 * If a preset names a control the catalogue does not know, or carries a value
 * the API would reject, the operator finds out at the worst possible moment —
 * mid-sequence, with the array already part-way into a change.
 */

describe("control catalogue", () => {
  it("covers every service the platform renders", () => {
    for (const service of CONSOLE_SERVICES) {
      expect(controlsFor(service).length, `${service} has no controls`).toBeGreaterThan(0);
    }
  });

  it("never declares the same control twice for one service", () => {
    const seen = new Set<string>();
    for (const spec of CONTROLS) {
      const key = `${spec.service}:${spec.control}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("explains every control, because the panel has to justify the button", () => {
    for (const spec of CONTROLS) {
      expect(spec.label.length, spec.control).toBeGreaterThan(0);
      expect(spec.description.length, spec.control).toBeGreaterThan(10);
    }
  });

  it("bounds the habitat temperature setpoint at both ends", () => {
    const spec = getControl("MHE", "adjust_temperature");
    expect(spec).not.toBeNull();
    expect(validateControlValue(spec!, 293, "quarters-1")).toBeNull();
    expect(validateControlValue(spec!, 250, "quarters-1")).toContain("at least");
    expect(validateControlValue(spec!, 320, "quarters-1")).toContain("at most");
    expect(validateControlValue(spec!, "293", "quarters-1")).toContain("number");
  });

  it("only accepts booleans for a boolean control, and true for a one-shot", () => {
    const seal = getControl("MHE", "seal_room")!;
    expect(validateControlValue(seal, true, "lab")).toBeNull();
    expect(validateControlValue(seal, false, "lab")).toBeNull();
    expect(validateControlValue(seal, "true", "lab")).toContain("true or false");

    // A one-shot only makes sense as `true`; `false` would be a no-op command.
    const wellness = getControl("MHE", "crew_wellness_check")!;
    expect(validateControlValue(wellness, true, "crew-1")).toBeNull();
    expect(validateControlValue(wellness, false, "crew-1")).toContain("only accepts true");
  });

  it("refuses a schedule in the past and accepts one in the future", () => {
    const spec = getControl("RTA", "schedule_scan")!;
    expect(validateControlValue(spec, Date.now() + 60_000, "main")).toBeNull();
    expect(validateControlValue(spec, Date.now() - 60_000, "main")).toContain("future");
    // 0 clears the schedule.
    expect(validateControlValue(spec, 0, "main")).toBeNull();
  });

  it("validates an enum against the values the service publishes", () => {
    const spec = getControl("OPG", "generation_priority")!;
    expect(validateControlValue(spec, "solar_first", "global")).toBeNull();
    expect(validateControlValue(spec, "cheapest_first", "global")).toContain("one of");
  });

  it("validates a science target object as well as a catalogue id", () => {
    const spec = getControl("RTA", "set_target")!;
    expect(validateControlValue(spec, "sgr-a", "main")).toBeNull();
    expect(
      validateControlValue(spec, { ra_rad: 1.2, dec_rad: -0.4, fov_rad: 0.02 }, "main"),
    ).toBeNull();
    expect(validateControlValue(spec, { ra_rad: 9, dec_rad: 0, fov_rad: 0.02 }, "main")).toContain("ra_rad");
  });

  it("pins plant-level commands to the unit they act on", () => {
    // The diesel plant is a single unit, so its commands carry a fixed entity
    // rather than accepting whatever the operator typed.
    for (const control of ["start_generator", "stop_generator"]) {
      expect(getControl("OPG", control)?.entity, control).toBe("diesel");
    }
  });
});

describe("presets", () => {
  it("only names controls the platform catalogues", () => {
    for (const preset of PRESETS) {
      for (const step of preset.steps) {
        expect(getControl(preset.service, step.control), `${preset.id} → ${step.control}`).not.toBeNull();
      }
    }
  });

  it("carries values the same validator the command API uses accepts", () => {
    for (const preset of PRESETS) {
      expect(preset.steps.length, preset.id).toBeGreaterThan(0);
      for (const step of preset.steps) {
        const spec = getControl(preset.service, step.control)!;
        const entity = typeof step.entity === "string" && step.entity !== "@selected" ? step.entity : "d-001";
        expect(validateControlValue(spec, step.value, entity), `${preset.id} → ${step.control}`).toBeNull();
      }
    }
  });

  it("gives every preset a rationale in the researcher's terms", () => {
    for (const preset of PRESETS) {
      expect(preset.name.length, preset.id).toBeGreaterThan(3);
      expect(preset.rationale.length, preset.id).toBeGreaterThan(20);
    }
  });

  it("groups presets by service, so a console only shows its own", () => {
    for (const service of CONSOLE_SERVICES) {
      expect(presetsFor(service).length, `${service} has no presets`).toBeGreaterThan(0);
      expect(presetsFor(service).every((preset) => preset.service === service)).toBe(true);
    }
  });

  it("knows which presets cannot run without a selection", () => {
    const needsSelection = PRESETS.filter((preset) => preset.steps.some((step) => step.entity === "@selected"));
    expect(needsSelection.length).toBeGreaterThan(0);
    expect(needsSelection.every((preset) => presetNeedsSelection(preset))).toBe(true);
  });
});
