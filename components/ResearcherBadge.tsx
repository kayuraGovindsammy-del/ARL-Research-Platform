"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { verifyResearcherRequest } from "@/lib/api-client";
import { useOperator } from "@/lib/use-operator";
import type { Service } from "@/lib/types";
import { Badge, StatusDot, type Tone } from "./ui";

/**
 * Researcher identity shown in the header.
 *
 * Commands are attributed to this code and each service authorises per
 * experiment, so the badge doubles as a permission check: it verifies the code
 * against the dashboard in view and lets the operator switch codes inline when
 * the current one is not permitted (for example a RTA-only code on the OPG
 * console).
 */

const PATH_SERVICE: Array<[string, Service]> = [
  ["/rta", "RTA"],
  ["/mhe", "MHE"],
  ["/opg", "OPG"],
];

function serviceFor(pathname: string): Service | null {
  const match = PATH_SERVICE.find(([prefix]) => pathname.startsWith(prefix));
  return match ? match[1] : null;
}

type Verdict = { state: "unchecked" } | { state: "valid" } | { state: "invalid"; reason: string };

function verdictTone(verdict: Verdict): Tone {
  if (verdict.state === "valid") return "ok";
  if (verdict.state === "invalid") return "alert";
  return "neutral";
}

export function ResearcherBadge() {
  const pathname = usePathname();
  const service = serviceFor(pathname);
  const { operator, setOperator } = useOperator();
  const [verdict, setVerdict] = useState<Verdict>({ state: "unchecked" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!operator) {
      setVerdict({ state: "unchecked" });
      return;
    }
    let cancelled = false;
    setVerdict({ state: "unchecked" });
    void verifyResearcherRequest(operator, service ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setVerdict(
          result.valid
            ? { state: "valid" }
            : { state: "invalid", reason: result.reason ?? "not_permitted" },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVerdict({
          state: "invalid",
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [operator, service]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next) setOperator(next);
    setEditing(false);
  };

  const tone = verdictTone(verdict);
  const scope = service ? service.toLowerCase() : "any experiment";
  const title =
    verdict.state === "valid"
      ? `${operator} is permitted on ${scope}`
      : verdict.state === "invalid"
        ? `${operator} may not command ${scope}: ${verdict.reason}`
        : "Researcher code is being checked";

  if (editing) {
    return (
      <form onSubmit={submit} className="flex items-center gap-1">
        <input
          autoFocus
          className="input h-7 w-32 py-0"
          value={draft}
          placeholder="researcher code"
          aria-label="Researcher code"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <button type="submit" className="btn h-7 px-2 py-0 text-[10px]">
          set
        </button>
        <button
          type="button"
          className="btn h-7 px-2 py-0 text-[10px]"
          onClick={() => setEditing(false)}
        >
          cancel
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        setDraft(operator);
        setEditing(true);
      }}
      className="rounded-full"
    >
      <Badge tone={tone}>
        <StatusDot tone={tone} pulse={verdict.state === "invalid"} />
        {operator || "no researcher"}
      </Badge>
    </button>
  );
}
