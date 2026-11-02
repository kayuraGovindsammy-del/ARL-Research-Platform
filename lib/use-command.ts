"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, sendControl, type CommandRequest } from "./api-client";
import type { CommandOutcome, CommandResult } from "./types";

export interface CommandFeedback {
  tone: "ok" | "warn" | "alert";
  text: string;
  outcome?: CommandOutcome;
}

const OUTCOME_TONE: Record<CommandOutcome, CommandFeedback["tone"]> = {
  completed: "ok",
  rejected: "warn",
  failed: "alert",
  timeout: "warn",
};

/**
 * Shared control dispatch state: the in-flight control + transient operator
 * feedback.
 *
 * The service answers every command with an ack, and that verdict is what the
 * operator needs to read: `completed` is success, `rejected` means the guard in
 * the service refused it (with a reason), `timeout` means it was accepted but
 * the terminal ack never arrived. Transport failures (broker down, validation)
 * throw from the API route instead.
 */
export function useCommandRunner() {
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<CommandFeedback | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 8000);
    return () => clearTimeout(timer);
  }, [feedback]);

  /**
   * Dispatch one control. Resolves to the service's command result (or null
   * when the request never reached the broker), so multi-step callers such as
   * the preset runner can report each step instead of only the last one.
   */
  const run = useCallback(
    async (request: CommandRequest, label?: string): Promise<CommandResult | null> => {
      const name = label ?? request.control;
      setPending(request.control);
      try {
        const { result } = await sendControl(request);
        setFeedback({
          tone: OUTCOME_TONE[result.outcome],
          text: `${name} → ${result.message}`,
          outcome: result.outcome,
        });
        return result;
      } catch (caught) {
        const message =
          caught instanceof ApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : String(caught);
        setFeedback({ tone: "alert", text: `${name} failed: ${message}` });
        return null;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { run, pending, feedback, clearFeedback: () => setFeedback(null) };
}
