import { NextRequest, NextResponse } from "next/server";
import { AlertOperationError, acknowledgeAlert } from "@/lib/alerts";
import { authoriseAlertAction } from "@/lib/alert-auth";

/**
 * POST /api/alerts/:id/acknowledge
 * body: { researcher: string, note?: string }
 *
 * Moves the alert to ACKNOWLEDGED and records the operator identity plus an
 * AuditLog entry. The researcher code must be cleared for the alert's service
 * (ARL `/v1/researchers/verify`), so an alert can only be handled by someone
 * with access to that component.
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
    // Entitlement first: an unauthorised attempt is audited and never touches
    // the alert row, so the lifecycle below only sees permitted operators.
    const { auth } = await authoriseAlertAction(params.id, researcher);
    const alert = await acknowledgeAlert(params.id, researcher, note);
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
    console.error("[alerts] acknowledge failed:", error);
    return NextResponse.json({ error: "Failed to acknowledge alert." }, { status: 500 });
  }
}
