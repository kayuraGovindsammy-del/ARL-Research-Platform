import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/alerts";
import { CONTROL_ENTITY_HINT, getControl, validateControlValue } from "@/lib/controls";
import { getMqttWorker } from "@/lib/mqtt-worker";
import { checkCommandPermission } from "@/lib/researcher-auth";
import { SERVICES, type Service } from "@/lib/types";

/**
 * POST /api/controls
 *
 * Publishes one operator control and waits for the service's ack:
 *
 *   body: { service, entity, control, value, researcher }
 *   wire: arl/<service>/cmd/<entity>/<control>  ←  {command_id, researcher, value}
 *   ack:  arl/<service>/ack/<command_id>        →  accepted → completed | rejected
 *
 * Four checks run before anything reaches the broker, so a mistake is caught
 * while the operator is still looking at the form:
 *
 *   1. the control exists for that service (catalogue in `lib/controls.ts`)
 *   2. the entity is resolvable and the value is in range
 *   3. the researcher code is cleared for that experiment (ARL `/v1/researchers`)
 *   4. the broker is connected
 *
 * The response is always 200 once the command was delivered; `result.outcome`
 * carries the service's verdict (completed/rejected/failed/timeout).
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
  // Driven by the shared service list, so a new service needs no change here.
  service: z.enum(SERVICES),
  /** Dish id, room id, crew id, sub-array name, or the fixed entity of a global control. */
  entity: z.string().trim().min(1).max(64).optional(),
  control: z.string().trim().min(1).max(64),
  value: z.unknown(),
  researcher: z.string().trim().min(2).max(120).optional(),
});

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

  try {
    const spec = getControl(service, input.control);
    if (!spec) {
      throw new ControlError(`'${input.control}' is not a ${service} control.`);
    }

    // Global controls address one named entity (e.g. OPG `global`, `solar`);
    // per-entity controls must name their target.
    const entity = spec.entity ?? input.entity;
    if (!entity) {
      throw new ControlError(`${spec.label} needs an entity (${CONTROL_ENTITY_HINT[spec.entityKind]}).`);
    }

    const invalid = validateControlValue(spec, input.value, entity);
    if (invalid) throw new ControlError(invalid);

    const researcher = input.researcher?.trim() ?? "";
    // Fail fast when the code cannot command this experiment: the service would
    // reject it anyway, but only after a publish/ack round trip.
    const auth = await checkCommandPermission(researcher, service);
    if (!auth.allowed) {
      await writeAuditLog(
        "CONTROL_DENIED",
        researcher || "(none)",
        `${service} ${input.control} → ${entity} denied — ${auth.reason}`,
      );
      return NextResponse.json(
        { error: auth.reason, reason: "researcher_not_permitted", auth },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const worker = getMqttWorker();
    const result = await worker.executeControl({
      service,
      entity,
      control: input.control,
      value: input.value,
      researcher,
    });

    await writeAuditLog(
      `CONTROL_${input.control.toUpperCase()}`,
      researcher,
      `${service} ${input.control} → ${entity} = ${JSON.stringify(input.value)} · ${result.outcome}${
        result.ack?.reason ? ` (${result.ack.reason})` : ""
      }`,
    );

    return NextResponse.json(
      { ok: result.outcome === "completed", result, auth },
      { headers: { "Cache-Control": "no-store" } },
    );
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
