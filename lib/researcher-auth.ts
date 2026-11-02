import { ArlApiError, verifyResearcher } from "./arl-api";
import type { Service } from "./types";

/**
 * Command authorisation.
 *
 * The lab's researcher codes are experiment-scoped: `arl-as3` may command the
 * telescope but not the power plant, and the services reject a command from a
 * code they do not recognise with `reason: "researcher_not_permitted"`. That
 * round trip costs an operator a full publish/ack cycle to learn something the
 * ARL API can answer up front, so the control route checks the code *before*
 * publishing and returns 403 with the API's reason.
 *
 * Fail-open policy: if the ARL API cannot be reached, the command is allowed
 * through and the response carries `auth.source: "unavailable"`. The service
 * still enforces its own permission check, so failing open degrades to the
 * previous behaviour instead of grounding the lab because a REST endpoint is
 * down. The decision is logged either way.
 */

export interface AuthVerdict {
  allowed: boolean;
  reason: string;
  researcher: { code: string; name: string } | null;
  source: "cache" | "arl" | "unavailable";
}

/** A verdict older than this is re-checked against the ARL API. */
const VERDICT_TTL_MS = 60 * 1000;

const verdicts = new Map<string, { expiresAt: number; verdict: AuthVerdict }>();

export function clearAuthCache(): void {
  verdicts.clear();
}

function cacheKey(code: string, service: Service): string {
  return `${code.trim().toLowerCase()}|${service.toLowerCase()}`;
}

/**
 * The ARL API answers with `unknown`, `defunct` or `not_permitted`; each one
 * means a different thing to the person at the console, so they are spelled out
 * rather than passed through as a bare token.
 */
function explain(reason: string | undefined, code: string, service: Service): string {
  switch ((reason ?? "").toLowerCase()) {
    case "not_permitted":
      return `${code} is registered with the ARL but is not cleared for ${service}. Use a code with the ${service} experiment, or ask the lab to entitle this one.`;
    case "unknown":
    case "unknown researcher":
      return `Researcher code '${code}' is not registered with the ARL, so ${service} would reject the command.`;
    case "defunct":
      return `Researcher code '${code}' is marked defunct by the ARL and can no longer command ${service}.`;
    default:
      return `${code} cannot command ${service}${reason ? ` (${reason})` : ""}.`;
  }
}

export async function checkCommandPermission(
  code: string | null | undefined,
  service: Service,
): Promise<AuthVerdict> {
  const trimmed = (code ?? "").trim();
  if (trimmed.length < 2) {
    return {
      allowed: false,
      reason: "A researcher code is required to command the lab.",
      researcher: null,
      source: "arl",
    };
  }

  const key = cacheKey(trimmed, service);
  const cached = verdicts.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.verdict, source: "cache" };
  }

  try {
    const result = await verifyResearcher(trimmed, service.toLowerCase() as
      | "rta"
      | "mhe"
      | "lwm"
      | "opg"
      | "owt");
    const verdict: AuthVerdict = result.valid
      ? {
          allowed: true,
          reason: `${result.researcher?.name ?? trimmed} is cleared for ${service}.`,
          researcher: {
            code: result.researcher?.code ?? trimmed,
            name: result.researcher?.name ?? trimmed,
          },
          source: "arl",
        }
      : {
          allowed: false,
          reason: explain(result.reason, trimmed, service),
          researcher: result.researcher,
          source: "arl",
        };
    verdicts.set(key, { expiresAt: Date.now() + VERDICT_TTL_MS, verdict });
    return verdict;
  } catch (error) {
    const message = error instanceof ArlApiError ? error.message : String(error);
    console.warn(`[auth] researcher check unavailable for ${service}: ${message}`);
    return {
      allowed: true,
      reason: "ARL API unreachable — the service enforces permissions on its own ack.",
      researcher: { code: trimmed, name: trimmed },
      source: "unavailable",
    };
  }
}
