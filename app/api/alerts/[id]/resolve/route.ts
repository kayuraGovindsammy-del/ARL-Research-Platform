import { NextRequest, NextResponse } from "next/server";
import { AlertOperationError, resolveAlert } from "@/lib/alerts";

/**
 * POST /api/alerts/:id/resolve
 * body: { researcher: string, resolutionNote: string }
 *
 * Moves the alert to RESOLVED, stores the resolution text and writes an
 * AuditLog entry.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const researcher = String(body.researcher ?? body.resolvedBy ?? body.actor ?? "").trim();
  const resolutionNote = String(
    body.resolutionNote ?? body.resolution ?? body.note ?? "",
  ).trim();

  try {
    const alert = await resolveAlert(params.id, researcher, resolutionNote);
    return NextResponse.json({ alert }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AlertOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[alerts] resolve failed:", error);
    return NextResponse.json({ error: "Failed to resolve alert." }, { status: 500 });
  }
}
