import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/alerts";
import { getMqttWorker } from "@/lib/mqtt-worker";
import type { Service } from "@/lib/types";

/**
 * POST /api/controls
 *
 * Operator commands are validated here, published to
 * `arl/<service>/cmd/<action>` on the broker and written to the audit trail.
 *
 * body: { service, action, issuedBy, ...actionParams }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class ControlError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ControlError";
    this.status = status;
  }
}

const bodySchema = z.object({
  service: z.enum(["RTA", "MHE", "OPG"]),
  action: z.string().trim().min(1).max(64),
  issuedBy: z.string().trim().min(2).max(120).optional(),
  targetId: z.string().trim().min(1).max(120).optional(),
  custom: z.boolean().optional(),
  ra: z.number().finite().optional(),
  dec: z.number().finite().optional(),
  dishId: z.string().trim().min(1).max(64).optional(),
  subArray: z.string().trim().min(1).max(64).optional(),
  roomId: z.string().trim().min(1).max(64).optional(),
  temperatureC: z.number().finite().min(-20).max(45).optional(),
  lightLevelPct: z.number().finite().min(0).max(100).optional(),
  crewId: z.string().trim().min(1).max(64).optional(),
  source: z.enum(["SOLAR", "BATTERY", "DIESEL"]).optional(),
});

type ActionKey =
  | "scan.start"
  | "scan.pause"
  | "scan.resume"
  | "scan.cancel"
  | "dish.disable"
  | "dish.enable"
  | "dish.stow"
  | "array.stow"
  | "array.subArray"
  | "room.temperature"
  | "room.light"
  | "crew.wellnessCheck"
  | "airlock.pressurize"
  | "source.select"
  | "loadShedding.enable"
  | "loadShedding.disable"
  | "solar.enable"
  | "solar.disable"
  | "diesel.start"
  | "diesel.stop";

const ALLOWED_ACTIONS: Record<Service, ActionKey[]> = {
  RTA: [
    "scan.start",
    "scan.pause",
    "scan.resume",
    "scan.cancel",
    "dish.disable",
    "dish.enable",
    "dish.stow",
    "array.stow",
    "array.subArray",
  ],
  MHE: ["room.temperature", "room.light", "crew.wellnessCheck", "airlock.pressurize"],
  OPG: [
    "source.select",
    "loadShedding.enable",
    "loadShedding.disable",
    "solar.enable",
    "solar.disable",
    "diesel.start",
    "diesel.stop",
  ],
};

function requireField<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined || value === null || value === "") {
    throw new ControlError(`Field '${field}' is required for action '${action}'.`);
  }
  return value;
}

function buildParams(
  service: Service,
  action: ActionKey,
  input: z.infer<typeof bodySchema>,
): Record<string, unknown> {
  switch (action) {
    case "scan.start":
      return {
        targetId: requireField(input.targetId, "targetId", action),
        custom: Boolean(input.custom),
        ra: input.ra ?? null,
        dec: input.dec ?? null,
      };
    case "dish.disable":
    case "dish.enable":
    case "dish.stow":
      return { dishId: requireField(input.dishId, "dishId", action) };
    case "array.subArray":
      return {
        dishId: requireField(input.dishId, "dishId", action),
        subArray: requireField(input.subArray, "subArray", action),
      };
    case "room.temperature":
      return {
        roomId: requireField(input.roomId, "roomId", action),
        temperatureC: requireField(input.temperatureC, "temperatureC", action),
      };
    case "room.light":
      return {
        roomId: requireField(input.roomId, "roomId", action),
        lightLevelPct: requireField(input.lightLevelPct, "lightLevelPct", action),
      };
    case "crew.wellnessCheck":
      return { crewId: requireField(input.crewId, "crewId", action) };
    case "airlock.pressurize":
      return { roomId: input.roomId ?? "airlock" };
    case "source.select":
      return { source: requireField(input.source, "source", action) };
    case "scan.pause":
    case "scan.resume":
    case "scan.cancel":
    case "array.stow":
    case "loadShedding.enable":
    case "loadShedding.disable":
    case "solar.enable":
    case "solar.disable":
    case "diesel.start":
    case "diesel.stop":
      return {};
    default:
      throw new ControlError(`Unsupported action '${action}'.`);
  }
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid control request.",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      { status: 422 },
    );
  }

  const input = parsed.data;
  const service = input.service as Service;
  const action = input.action as ActionKey;

  if (!ALLOWED_ACTIONS[service].includes(action)) {
    return NextResponse.json(
      { error: `Action '${action}' is not valid for ${service}.` },
      { status: 422 },
    );
  }

  const issuedBy = input.issuedBy ?? "Console Operator";

  try {
    const params = buildParams(service, action, input);
    const worker = getMqttWorker();
    const { topic, envelope } = await worker.publishCommand(service, action, params, issuedBy);

    await writeAuditLog(
      `CONTROL_${action.replace(/[.\s]+/g, "_").toUpperCase()}`,
      issuedBy,
      `Published ${service} command to ${topic}: ${JSON.stringify(params)}`,
    );

    return NextResponse.json({ ok: true, topic, envelope }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ControlError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    const brokerDown = /not connected/i.test(message);
    console.error("[controls] publish failed:", message);
    return NextResponse.json(
      { error: brokerDown ? "MQTT broker is not connected." : "Failed to publish command.", detail: message },
      { status: brokerDown ? 503 : 500 },
    );
  }
}
