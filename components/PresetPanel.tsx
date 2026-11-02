"use client";

import { useState } from "react";
import type { CommandRequest } from "@/lib/api-client";
import { presetsFor, presetNeedsSelection, type ControlPreset } from "@/lib/presets";
import { SERVICE_ACCENT } from "@/lib/theme";
import type { CommandResult, Service } from "@/lib/types";
import { StepResult } from "./ConfirmButton";
import { Badge, Modal, Panel } from "./ui";

/**
 * Researcher presets panel.
 *
 * Every preset is shown with its rationale, its preconditions and the exact
 * sequence of controls it will publish, so the operator can see the whole plan
 * before the first command leaves the browser. Running one executes the steps
 * in order, stops on a critical rejection, and reports the service's verdict
 * for each step — a preset that half-succeeds is more dangerous than one that
 * fails outright, so the outcome is never hidden behind a single "done".
 */
export function PresetPanel({
  service,
  entity,
  operator,
  run,
  pending,
  className = "",
  title = "Researcher presets",
}: {
  service: Service;
  /** Currently selected dish/room, for `@selected` steps. */
  entity?: string | null;
  operator: string;
  run: (request: CommandRequest, label?: string) => Promise<CommandResult | null>;
  pending: string | null;
  className?: string;
  title?: string;
}) {
  const presets = presetsFor(service);
  const [confirming, setConfirming] = useState<ControlPreset | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ label: string; result: CommandResult | null }>>([]);

  const execute = async (preset: ControlPreset) => {
    setConfirming(null);
    setRunning(preset.id);
    setResults([]);
    for (const step of preset.steps) {
      const target = step.entity === "@selected" ? entity?.trim() : step.entity;
      if (step.entity === "@selected" && !target) {
        setResults((previous) => [...previous, { label: `${step.label} — no selection`, result: null }]);
        if (step.critical) break;
        continue;
      }
      const result = await run(
        {
          service,
          entity: target ?? "",
          control: step.control,
          value: step.value,
          researcher: operator,
        },
        step.label,
      );
      setResults((previous) => [...previous, { label: step.label, result }]);
      if (step.critical && result?.outcome !== "completed") break;
    }
    setRunning(null);
  };

  if (presets.length === 0) return null;

  return (
    <Panel
      className={className}
      accent={SERVICE_ACCENT[service]}
      title={title}
      subtitle="The sequences a researcher actually runs, with the preconditions and every step visible before you commit."
      actions={<Badge tone="neutral">{presets.length} presets</Badge>}
    >
      <ul className="space-y-2">
        {presets.map((preset) => {
          const needsSelection = presetNeedsSelection(preset);
          const blocked = (needsSelection && !entity) || running !== null || pending !== null;
          return (
            <li
              key={preset.id}
              className="rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-console-ink">{preset.name}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-console-muted">{preset.rationale}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary shrink-0 px-2.5 py-1 text-[10px]"
                  onClick={() => setConfirming(preset)}
                  disabled={blocked}
                  title={
                    needsSelection && !entity
                      ? "Select a dish or room first"
                      : `Run ${preset.steps.length} control(s) in order`
                  }
                >
                  {running === preset.id ? "Running…" : "Run"}
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-console-muted">
                <span className="uppercase tracking-[0.12em] text-console-info">
                  {preset.steps.length} step{preset.steps.length === 1 ? "" : "s"}
                </span>
                {preset.steps.map((step, index) => (
                  <span key={`${preset.id}-${step.control}-${index}`}>
                    {step.control}
                    {step.entity === "@selected" ? "(selected)" : ""}
                  </span>
                ))}
                {preset.requires && <span className="text-console-warn">{preset.requires}</span>}
              </div>
            </li>
          );
        })}
      </ul>

      {results.length > 0 && (
        <div className="mt-3 rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2">
          <p className="mb-1 text-[10px] uppercase tracking-[0.14em] text-console-muted">Last preset result</p>
          <ul className="space-y-0.5">
            {results.map((entry, index) => (
              <StepResult key={`${entry.label}-${index}`} label={entry.label} result={entry.result} />
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <Modal
          open
          title={`Run preset — ${confirming.name}`}
          description="Every step below is published as a separate control and acknowledged by the service."
          onClose={() => setConfirming(null)}
        >
          <p className="mb-3 text-xs leading-relaxed text-console-muted">{confirming.rationale}</p>
          <ol className="mb-3 space-y-1">
            {confirming.steps.map((step, index) => (
              <li key={`${step.control}-${index}`} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-console-muted">{index + 1}.</span>
                <span className="text-console-ink">{step.label}</span>
                <span className="ml-auto font-mono text-[10px] text-console-muted">
                  {step.control}
                  {step.entity === "@selected" ? ` → ${entity}` : step.entity ? ` → ${step.entity}` : ""}
                </span>
              </li>
            ))}
          </ol>
          {confirming.requires && (
            <p className="mb-3 rounded-md border border-console-warn/40 bg-console-warn/5 px-3 py-2 text-[11px] text-console-warn">
              Requires: {confirming.requires}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void execute(confirming)}>
              Run {confirming.steps.length} step{confirming.steps.length === 1 ? "" : "s"}
            </button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
