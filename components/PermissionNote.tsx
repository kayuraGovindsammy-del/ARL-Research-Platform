"use client";

import { useEffect, useState } from "react";
import type { Service } from "@/lib/types";

/**
 * "May this researcher command this service?" — asked before the operator
 * presses anything, not after.
 *
 * The lab scopes a researcher code per experiment, and the service rejects an
 * unentitled command only after a publish/ack round trip. `/api/arl/researcher`
 * answers the same question against the ARL API, so the console can say
 * "read-only for this code" while the operator is still reading the page.
 *
 * Nothing is rendered when the code is cleared: a permission banner on every
 * console would be noise. A denial, or an unreachable API, is worth the space.
 */
interface Verdict {
  valid: boolean;
  reason: string | null;
}

function explain(reason: string | null, code: string, service: Service): string {
  switch ((reason ?? "").toLowerCase()) {
    case "not_permitted":
      return `${code} is registered with the ARL but is not cleared for ${service}. Every command from this code would be rejected by the service, so this console is read-only until the lab entitles it.`;
    case "unknown":
    case "unknown researcher":
      return `The ARL does not recognise the researcher code '${code}', so ${service} would reject its commands. Check the code in the operator field.`;
    case "defunct":
      return `The ARL marks '${code}' as defunct; ${service} no longer accepts commands from it.`;
    default:
      return `${code} cannot command ${service}${reason ? ` (${reason})` : ""}.`;
  }
}

export function PermissionNote({
  service,
  code,
  className = "",
}: {
  service: Service;
  code: string;
  className?: string;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = code.trim();
    if (trimmed.length < 2) {
      setVerdict(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/arl/researcher?service=${service.toLowerCase()}&code=${encodeURIComponent(trimmed)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = (await response.json()) as { valid?: boolean; reason?: string | null; error?: string };
        if (body.error) {
          setVerdict(null);
          setError(body.error);
          return;
        }
        setError(null);
        setVerdict({ valid: body.valid === true, reason: body.reason ?? null });
      } catch (caught) {
        if ((caught as Error)?.name === "AbortError") return;
        setVerdict(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();

    return () => controller.abort();
  }, [service, code]);

  if (verdict?.valid) return null;

  if (error) {
    return (
      <div
        className={`panel border-console-warn/40 bg-console-warn/5 px-4 py-2.5 text-xs text-console-warn ${className}`}
      >
        Could not check researcher permission against the ARL API ({error}). Commands are still
        gated by the service's own ack.
      </div>
    );
  }

  if (!verdict) return null;

  return (
    <div
      className={`panel border-console-alert/50 bg-console-alert/5 px-4 py-2.5 ${className}`}
      role="note"
    >
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-console-alert">
        Read-only · researcher not cleared for {service}
      </p>
      <p className="mt-1 text-xs leading-snug text-console-ink">
        {explain(verdict.reason, code.trim(), service)}
      </p>
    </div>
  );
}
