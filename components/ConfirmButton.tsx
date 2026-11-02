"use client";

import { useState } from "react";
import type { CommandResult } from "@/lib/types";
import { Modal } from "./ui";

/**
 * A button that asks before it acts.
 *
 * Several controls are hard to undo or physically consequential — cancelling a
 * scan throws away the integration time accumulated so far, stowing a dish
 * takes it out of the array, stopping the generator starts a 60 s cool-down.
 * Wrapping those in a confirmation with an explicit impact statement is the
 * safeguard the operator gets instead of a shrug when they misclick.
 */
export function ConfirmButton({
  label,
  impact,
  confirmLabel = "Confirm",
  onConfirm,
  disabled = false,
  className = "btn",
  title,
}: {
  label: React.ReactNode;
  /** What happens if this goes ahead — shown in the dialog. */
  impact: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={title}
      >
        {label}
      </button>
      <Modal
        open={open}
        title="Confirm action"
        description="Destructive controls ask before they reach the service."
        onClose={() => (busy ? undefined : setOpen(false))}
      >
        <p className="mb-4 rounded-md border border-console-warn/40 bg-console-warn/5 px-3 py-2 text-xs text-console-warn">
          {impact}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Sending…" : confirmLabel}
          </button>
        </div>
      </Modal>
    </>
  );
}

/** Compact per-step outcome row used by the preset runner. */
export function StepResult({
  label,
  result,
}: {
  label: string;
  result: CommandResult | null;
}) {
  const outcome = result?.outcome ?? "not sent";
  const tone =
    outcome === "completed"
      ? "text-console-ok"
      : outcome === "rejected" || outcome === "timeout"
        ? "text-console-warn"
        : "text-console-alert";
  return (
    <li className="flex items-baseline gap-2 text-[11px]">
      <span className={`font-mono uppercase tracking-[0.1em] ${tone}`}>{outcome}</span>
      <span className="text-console-ink">{label}</span>
      {result?.message && <span className="truncate text-console-muted">{result.message}</span>}
    </li>
  );
}
