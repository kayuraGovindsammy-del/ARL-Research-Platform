"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { THEME } from "@/lib/theme";

export type Tone = "neutral" | "ok" | "warn" | "alert" | "info" | "signal";

/** The palette value behind each tone, for inline styles that need a literal. */
export const toneAccent: Record<Tone, string> = {
  neutral: THEME.muted,
  ok: THEME.ok,
  warn: THEME.warn,
  alert: THEME.alert,
  info: THEME.info,
  signal: THEME.signal,
};

export const toneText: Record<Tone, string> = {
  neutral: "text-console-muted",
  ok: "text-console-ok",
  warn: "text-console-warn",
  alert: "text-console-alert",
  info: "text-console-info",
  signal: "text-console-signal",
};

export const toneBorder: Record<Tone, string> = {
  neutral: "border-console-edge text-console-muted",
  ok: "border-console-ok/50 bg-console-ok/10 text-console-ok",
  warn: "border-console-warn/50 bg-console-warn/10 text-console-warn",
  alert: "border-console-alert/50 bg-console-alert/10 text-console-alert",
  info: "border-console-info/50 bg-console-info/10 text-console-info",
  signal: "border-console-signal/50 bg-console-signal/10 text-console-signal",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`badge ${toneBorder[tone]} ${className}`}>{children}</span>;
}

export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const colors: Record<Tone, string> = {
    neutral: "bg-console-muted",
    ok: "bg-console-ok",
    warn: "bg-console-warn",
    alert: "bg-console-alert",
    info: "bg-console-info",
    signal: "bg-console-signal",
  };
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${colors[tone]} ${pulse ? "blink" : ""}`} />
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
  accent,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Service colour for the panel's filament, e.g. `#ffc978` for RTA. */
  accent?: string;
}) {
  return (
    <section
      className={`panel ${accent ? "panel-accent" : ""} ${className}`}
      style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}
    >
      {(title || actions) && (
        <header className="panel-header">
          <div className="min-w-0">
            {title && <h2 className="panel-title">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-console-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  className = "",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-console-edge/50 px-3 py-2 ${className}`}
      style={{
        background:
          "linear-gradient(160deg, rgba(61,42,34,0.35), rgba(16,12,11,0.55))",
      }}
    >
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone === "neutral" ? "" : toneText[tone]}`}>
        {value}
        {unit && <span className="ml-1 font-mono text-xs font-medium text-console-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-console-muted">{hint}</div>}
    </div>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = "signal",
  height = "h-1.5",
}: {
  value: number;
  max?: number;
  tone?: Tone;
  height?: string;
}) {
  const colors: Record<Tone, string> = {
    neutral: "bg-console-muted",
    ok: "bg-console-ok",
    warn: "bg-console-warn",
    alert: "bg-console-alert",
    info: "bg-console-info",
    signal: "bg-console-signal",
  };
  const percent = max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0;
  return (
    <div className={`w-full overflow-hidden rounded-full border border-console-edge/60 bg-console-void/80 ${height}`}>
      <div
        className={`h-full rounded-full ${colors[tone]} transition-all`}
        style={{ width: `${percent}%`, boxShadow: "0 0 12px -2px currentColor" }}
      />
    </div>
  );
}

export function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-console-edge/80 px-4 py-6 text-center">
      <p className="text-sm text-console-muted">{message}</p>
      {hint && <p className="mt-1 text-xs text-console-muted/70">{hint}</p>}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-console-void/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel relative z-10 w-full max-w-lg border-console-edge p-5"
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-console-signal">{title}</h3>
          {description && <p className="mt-1 text-xs text-console-muted">{description}</p>}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
