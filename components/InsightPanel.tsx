"use client";

import { Badge, Panel, ProgressBar, toneText, type Tone } from "./ui";

export interface InsightEvidence {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** 0–100 — renders as a bar under the value when present. */
  percent?: number;
  tone?: Tone;
}

/**
 * A derived answer to a question the researcher would actually ask.
 *
 * The consoles are full of measurements; this panel is the sentence those
 * measurements add up to. It is deliberately opinionated — it commits to a
 * yes/no or a number — and always shows the evidence it committed from, so the
 * operator can disagree with the conclusion without leaving the page.
 */
export function InsightPanel({
  question,
  answer,
  tone = "info",
  evidence,
  footnote,
  className = "",
}: {
  question: string;
  answer: React.ReactNode;
  tone?: Tone;
  evidence: InsightEvidence[];
  footnote?: React.ReactNode;
  className?: string;
}) {
  const answerTone =
    tone === "alert"
      ? "text-console-alert"
      : tone === "warn"
        ? "text-console-warn"
        : tone === "ok"
          ? "text-console-ok"
          : "text-console-ink";

  return (
    <Panel
      className={className}
      title="Research answer"
      subtitle={question}
      actions={<Badge tone={tone}>{tone === "ok" ? "nominal" : tone}</Badge>}
    >
      <p className={`text-base font-medium leading-snug ${answerTone}`}>{answer}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {evidence.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-console-edge/60 bg-console-void/40 px-3 py-2"
          >
            <p className="text-[10px] uppercase tracking-[0.14em] text-console-muted">{item.label}</p>
            <p className={`mt-0.5 font-mono text-sm ${item.tone ? toneText[item.tone] : "text-console-ink"}`}>
              {item.value}
            </p>
            {typeof item.percent === "number" && (
              <div className="mt-1.5">
                <ProgressBar value={item.percent} max={100} tone={item.tone ?? "signal"} />
              </div>
            )}
            {item.hint && <p className="mt-1 text-[10px] text-console-muted">{item.hint}</p>}
          </div>
        ))}
      </div>
      {footnote && <p className="mt-2 text-[11px] leading-snug text-console-muted">{footnote}</p>}
    </Panel>
  );
}
