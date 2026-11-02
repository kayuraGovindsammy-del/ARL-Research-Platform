import { NextResponse } from "next/server";
import { getMetadata, getParameters } from "@/lib/arl-api";
import { arlApiDocsUrl } from "@/lib/env";

/**
 * GET /api/arl/metadata
 *
 * Lab identity plus the controller parameter catalogue. Either section may be
 * unavailable independently; the response reports both outcomes so the home
 * page can render a partial configuration view.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [metadata, parameters] = await Promise.allSettled([getMetadata(), getParameters()]);

  const errors: string[] = [];
  if (metadata.status === "rejected") {
    errors.push(`metadata: ${metadata.reason instanceof Error ? metadata.reason.message : String(metadata.reason)}`);
  }
  if (parameters.status === "rejected") {
    errors.push(`parameters: ${parameters.reason instanceof Error ? parameters.reason.message : String(parameters.reason)}`);
  }

  return NextResponse.json(
    {
      metadata: metadata.status === "fulfilled" ? metadata.value : null,
      parameters: parameters.status === "fulfilled" ? parameters.value : [],
      errors,
      docsUrl: arlApiDocsUrl(),
      fetchedAt: new Date().toISOString(),
    },
    {
      status: errors.length === 2 ? 502 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
