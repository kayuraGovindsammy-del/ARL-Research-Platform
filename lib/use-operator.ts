"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "arl.operator";

/**
 * Researcher identity used for control commands and audit attribution, shared
 * by the header selector and every dashboard.
 *
 * The services authorise per experiment, so the identity has to be the real
 * researcher code (`ARL_RESEARCHER_CODE`) rather than a free-text label — a
 * made-up name is rejected with `researcher_not_permitted`. The console seeds
 * itself from the environment and lets the operator switch to another code
 * without a reload, so the fan-out is module level instead of a provider.
 */

const listeners = new Set<(value: string) => void>();

function broadcast(value: string) {
  for (const listener of listeners) listener(value);
}

let seeded: Promise<string> | null = null;

function readStorage(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The environment's researcher code, fetched once per page load. */
function seedFromEnvironment(): Promise<string> {
  seeded ??= fetch("/api/health", { cache: "no-store" })
    .then((response) => response.json() as Promise<{ researcher?: { code?: string } | null }>)
    .then((body) => body?.researcher?.code ?? "")
    .catch(() => "");
  return seeded;
}

export function useOperator() {
  const [operator, setOperatorState] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    listeners.add(setOperatorState);
    let cancelled = false;

    const stored = readStorage();
    if (stored) {
      setOperatorState(stored);
      setReady(true);
    } else {
      void seedFromEnvironment().then((code) => {
        if (cancelled) return;
        // A dashboard can mount before the fetch resolves; never overwrite a
        // code the operator already typed.
        setOperatorState((current) => current || code);
        setReady(true);
      });
    }

    return () => {
      cancelled = true;
      listeners.delete(setOperatorState);
    };
  }, []);

  const setOperator = useCallback((value: string) => {
    setOperatorState(value);
    broadcast(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // storage unavailable — the in-memory value still applies
    }
  }, []);

  return { operator, setOperator, ready };
}
