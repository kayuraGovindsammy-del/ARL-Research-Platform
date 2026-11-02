import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ArlApiError, createTarget, deleteTarget, getTargets, invalidateArlCache } from "@/lib/arl-api";
import { arlApiDocsUrl } from "@/lib/env";

/**
 * GET    /api/arl/targets            cached pre-programmed target catalogue
 * GET    /api/arl/targets?refresh=1  bypass the in-memory cache
 * POST   /api/arl/targets            register a position as an observable target
 * DELETE /api/arl/targets?id=tgt-17  remove a custom target
 *
 * The catalogue is served by `GET /v1/targets`; positions are radians. POST is
 * what makes the RTA "custom sky position" flow work without leaving the
 * console — the service only accepts `set_target` for ids it knows about.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const newTargetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ra_rad: z.number().finite().min(0).max(Math.PI * 2),
  dec_rad: z.number().finite().min(-Math.PI / 2).max(Math.PI / 2),
  fov_rad: z.number().finite().min(0.0005).max(0.05),
  category: z.string().trim().max(40).optional(),
});

export async function GET(request: NextRequest) {
  const refresh = request.nextUrl.searchParams.get("refresh");
  if (refresh === "1" || refresh === "true") invalidateArlCache();

  try {
    const targets = await getTargets();
    return NextResponse.json(
      { targets, source: "arl", docsUrl: arlApiDocsUrl() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[arl] target catalogue unavailable:", message);
    return NextResponse.json(
      {
        targets: [],
        source: "unavailable",
        error: message,
        docsUrl: arlApiDocsUrl(),
        status: error instanceof ArlApiError ? error.status : null,
      },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = newTargetSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid target.",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      { status: 422 },
    );
  }

  try {
    const target = await createTarget({ ...parsed.data, category: parsed.data.category ?? "custom" });
    invalidateArlCache();
    return NextResponse.json({ target }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ArlApiError ? (error.status ?? 502) : 502;
    console.error("[arl] target create failed:", message);
    return NextResponse.json({ error: message }, { status: status >= 500 ? 502 : status });
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Query parameter 'id' is required." }, { status: 422 });
  }

  try {
    await deleteTarget(id);
    invalidateArlCache();
    return NextResponse.json({ ok: true, id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ArlApiError ? (error.status ?? 502) : 502;
    console.error("[arl] target delete failed:", message);
    return NextResponse.json({ error: message }, { status: status >= 500 ? 502 : status });
  }
}
