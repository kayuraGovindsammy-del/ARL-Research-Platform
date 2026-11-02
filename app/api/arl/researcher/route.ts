import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ArlApiError, verifyResearcher } from "@/lib/arl-api";

/**
 * GET  /api/arl/researcher?service=rta       validate the configured code
 * POST /api/arl/researcher {code, service}   validate a code the operator typed
 *
 * Every command is attributed to a researcher and the services validate that
 * field themselves, so the console checks it up front and can show who is
 * authorised for which experiment before a control is armed. Permission is
 * per experiment, so the service code is part of the check.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICES = ["rta", "mhe", "lwm", "opg", "owt"] as const;
type Experiment = (typeof SERVICES)[number];

const bodySchema = z.object({
  code: z.string().trim().min(1).max(64),
  service: z.enum(SERVICES).optional(),
});

function asExperiment(value: string | null | undefined): Experiment {
  const normalized = (value ?? "rta").trim().toLowerCase();
  return (SERVICES as readonly string[]).includes(normalized) ? (normalized as Experiment) : "rta";
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ArlApiError ? (error.status ?? 502) : 502;
  console.error("[arl] researcher verification failed:", message);
  return NextResponse.json({ error: message, valid: false }, { status: status >= 500 ? 502 : status });
}

export async function GET(request: NextRequest) {
  const nested = new URL(request.url);
  const code =
    nested.searchParams.get("code") ?? process.env.ARL_RESEARCHER_CODE ?? "";
  if (!code.trim()) {
    return NextResponse.json(
      { error: "No researcher code supplied and ARL_RESEARCHER_CODE is unset." },
      { status: 422 },
    );
  }

  try {
    const service = asExperiment(nested.searchParams.get("service"));
    const result = await verifyResearcher(code.trim(), service);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
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
    return NextResponse.json({ error: "A researcher code is required." }, { status: 422 });
  }

  try {
    const result = await verifyResearcher(parsed.data.code, asExperiment(parsed.data.service));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
