"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "arl.operator";

/**
 * Operator identity used for control commands and audit attribution. Persisted
 * so a researcher is not asked to retype their ID on every console action.
 */
export function useOperator() {
  const [operator, setOperatorState] = useState("Console Operator");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setOperatorState(stored);
    } catch {
      // storage unavailable — keep the in-memory default
    }
  }, []);

  const setOperator = useCallback((value: string) => {
    setOperatorState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignore persistence failures
    }
  }, []);

  return { operator, setOperator };
}
