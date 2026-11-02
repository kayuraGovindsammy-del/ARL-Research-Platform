import { NextRequest, NextResponse } from "next/server";
import { AlertOperationError, resolveAlert } from "@/lib/alerts";
import { authoriseAlertAction } from "@/lib/alert-auth";

/**
 * POST /api/alerts/:id/resolve
 * body: { researcher: string, resolutionNote: string }
 *
 * Moves the alert to RESOLVED, stores the resolution text and writes an
 * AuditLog entry. As with acknowledge, the researcher code must be cleared for
 * the alert's service before the alert can be handled.
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
    // Entitlement first: an unauthorised attempt is audited and never touches
    // the alert row.
    const { auth } = await authoriseAlertAction(params.id, researcher);
    const alert = await resolveAlert(params.id, researcher, resolutionNote);
    return NextResponse.json(
      { alert, auth },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AlertOperationError) {
      return NextResponse.json(
        {
          error: error.message,
          ...(error.status === 403 ? { reason: "researcher_not_permitted" } : {}),
        },
        { status: error.status },
      );
    }
    console.error("[alerts] resolve failed:", error);
    return NextResponse.json({ error: "Failed to resolve alert." }, { status: 500 });
  }
}
