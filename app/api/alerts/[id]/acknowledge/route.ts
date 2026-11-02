import { NextRequest, NextResponse } from "next/server";
import { AlertOperationError, acknowledgeAlert } from "@/lib/alerts";

/**
 * POST /api/alerts/:id/acknowledge
 * body: { researcher: string, note?: string }
 *
 * Moves the alert to ACKNOWLEDGED and records the operator identity plus an
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

  const researcher = String(body.researcher ?? body.acknowledgedBy ?? body.actor ?? "").trim();
  const note = body.note ? String(body.note) : undefined;

  try {
    const alert = await acknowledgeAlert(params.id, researcher, note);
    return NextResponse.json({ alert }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AlertOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[alerts] acknowledge failed:", error);
    return NextResponse.json({ error: "Failed to acknowledge alert." }, { status: 500 });
  }
}
