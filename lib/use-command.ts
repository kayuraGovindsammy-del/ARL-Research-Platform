"use client";

import { useCallback, useEffect, useState } from "react";
import { sendCommand, type CommandRequest } from "./api-client";

export interface CommandFeedback {
  tone: "ok" | "warn" | "alert";
  text: string;
}

/** Shared command dispatch state: pending action + transient operator feedback. */
export function useCommandRunner() {
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<CommandFeedback | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 8000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const run = useCallback(
    async (request: CommandRequest, label?: string) => {
      setPending(request.action);
      try {
        const result = await sendCommand(request);
        setFeedback({
          tone: "ok",
          text: `${label ?? request.action} accepted → ${result.topic}`,
        });
        return true;
      } catch (caught) {
        setFeedback({
          tone: "alert",
          text: `${label ?? request.action} failed: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        });
        return false;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { run, pending, feedback, clearFeedback: () => setFeedback(null) };
}
