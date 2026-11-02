"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ResearcherBadge } from "./ResearcherBadge";
import { Badge, StatusDot, type Tone } from "./ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/rta", label: "RTA" },
  { href: "/mhe", label: "MHE" },
  { href: "/opg", label: "OPG" },
  { href: "/alerts", label: "Alerts" },
];

/** Mars over a faint orbit ring: the console's mission mark. */
function MissionMark() {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
      <span
        aria-hidden
        className="absolute inset-0 rounded-full border border-console-signal/25"
      />
      <span
        aria-hidden
        className="absolute inset-1 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 34% 30%, #ffd0a3 0%, #ff7a45 38%, #a8452a 72%, #6d2c1c 100%)",
          boxShadow: "0 0 18px -2px rgba(255,122,69,0.75), inset -2px -2px 6px rgba(0,0,0,0.55)",
        }}
      />
      <span
        aria-hidden
        className="absolute h-9 w-9 rounded-full border-t border-console-sand/50"
        style={{ transform: "rotate(-28deg)" }}
      />
      <span className="absolute bottom-0.5 right-0 h-1.5 w-1.5 rounded-full bg-console-sand/80 shadow-[0_0_8px_#e8c8a4]" />
    </span>
  );
}

interface AlertSummary {
  ok: boolean;
  active: number;
  acknowledged: number;
  critical: number;
  warning: number;
  info: number;
  newest: {
    id: string;
    service: string;
    alertType: string;
    message: string;
    severity: string | null;
    status: string;
    timestamp: string;
  } | null;
}

interface HealthResponse {
  ok: boolean;
  env: { ok: boolean; error?: string };
  database: { ok: boolean; latestSampleAt?: string | null };
  alerts?: AlertSummary | null;
  mqtt: {
    state: string;
    connected: boolean;
    messagesIngested: number;
    alertsRaised: number;
    lastMessageAt: string | null;
    lastError: string | null;
  };
  arlApi: { docsUrl: string | null };
}

function healthTone(healthy: boolean, pending: boolean): Tone {
  if (pending) return "neutral";
  return healthy ? "ok" : "alert";
}

export function SiteHeader() {
  const pathname = usePathname();
  const [clock, setClock] = useState<string>("--:--:--");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const update = () =>
      setClock(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const body = (await response.json()) as HealthResponse;
        if (!cancelled) setHealth(body);
      } catch {
        if (!cancelled) setHealth(null);
      } finally {
        if (!cancelled) setChecked(true);
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const envOk = health?.env.ok ?? false;
  const dbOk = health?.database.ok ?? false;
  const brokerOk = health?.mqtt.connected ?? false;

  /*
   * The alert strip is part of the shell, not of any one service page: an
   * operator who has navigated to the wrong console still sees that something
   * is wrong elsewhere, how urgent it is and where to go. It is rendered from
   * the same health poll, so it survives an SSE outage that would blank the
   * per-service annunciators.
   */
  const alerts = health?.alerts ?? null;
  const unresolved = (alerts?.active ?? 0) + (alerts?.acknowledged ?? 0);
  const stripTone: Tone = !alerts
    ? "neutral"
    : alerts.critical > 0
      ? "alert"
      : unresolved > 0
        ? "warn"
        : "ok";

  return (
    <header className="sticky top-0 z-40 border-b border-console-edge/70 bg-console-void/80 backdrop-blur-md">
      <div
        aria-hidden
        className="h-px w-full bg-gradient-to-r from-transparent via-console-signal/50 to-transparent"
      />

      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
        <Link href="/" className="group flex items-center gap-3">
          <MissionMark />
          <span className="leading-tight">
            <span className="block font-display text-[14px] font-semibold uppercase tracking-[0.26em] text-console-ink">
              ARL Control
            </span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.22em] text-console-muted">
              Astro-Research Laboratory · Mars
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 rounded-lg border border-console-edge/60 bg-console-panel/50 p-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`relative rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors ${
                  active
                    ? "bg-console-rust/30 text-console-sand shadow-[inset_0_0_0_1px_rgba(255,122,69,0.35)]"
                    : "text-console-muted hover:bg-console-grid/70 hover:text-console-ink"
                }`}
              >
                {link.label}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-2.5 -bottom-[5px] h-0.5 rounded-full bg-console-signal shadow-[0_0_10px_#ff7a45]"
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ResearcherBadge />
          <Badge tone={healthTone(envOk, !checked)}>
            <StatusDot tone={healthTone(envOk, !checked)} />
            env
          </Badge>
          <Badge tone={healthTone(dbOk, !checked)}>
            <StatusDot tone={healthTone(dbOk, !checked)} />
            sqlite
          </Badge>
          <Badge tone={healthTone(brokerOk, !checked)}>
            <StatusDot tone={healthTone(brokerOk, !checked)} pulse={!brokerOk} />
            mqtt {health?.mqtt.state ?? ""}
          </Badge>
          <span className="rounded-md border border-console-edge/60 bg-console-grid/50 px-2 py-1 font-mono text-xs tabular-nums text-console-sand/90">
            {clock}
          </span>
        </div>
      </div>

      <Link
        href="/alerts"
        className={`block border-t transition-colors ${
          stripTone === "alert"
            ? "border-console-alert/50 bg-console-alert/10 hover:bg-console-alert/20"
            : stripTone === "warn"
              ? "border-console-warn/40 bg-console-warn/10 hover:bg-console-warn/20"
              : "border-console-edge/50 bg-console-panel/40 hover:bg-console-grid/50"
        }`}
      >
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 text-[11px]">
          <span
            className={`flex items-center gap-1.5 font-semibold uppercase tracking-[0.2em] ${
              stripTone === "alert"
                ? "text-console-alert"
                : stripTone === "warn"
                  ? "text-console-warn"
                  : stripTone === "ok"
                    ? "text-console-ok"
                    : "text-console-muted"
            }`}
          >
            <StatusDot tone={stripTone} pulse={stripTone === "alert"} />
            alerts
          </span>

          {!alerts ? (
            <span className="text-console-muted">alert summary unavailable</span>
          ) : unresolved === 0 ? (
            <span className="text-console-muted">
              none unresolved · {alerts.ok ? "all monitored thresholds nominal" : "alert store unavailable"}
            </span>
          ) : (
            <>
              <span className="font-mono tabular-nums text-console-ink">
                {alerts.active} active · {alerts.acknowledged} acknowledged
              </span>
              <span className="font-mono tabular-nums text-console-muted">
                {alerts.critical} critical / {alerts.warning} warning / {alerts.info} info
              </span>
              {alerts.newest && (
                <span className="min-w-0 flex-1 truncate text-console-muted">
                  <span className="font-mono uppercase tracking-[0.12em] text-console-solar">
                    {alerts.newest.service}
                  </span>{" "}
                  {alerts.newest.message}
                </span>
              )}
              <span className="ml-auto hidden shrink-0 font-mono uppercase tracking-[0.16em] text-console-signal sm:inline">
                open alert log →
              </span>
            </>
          )}
        </div>
      </Link>
    </header>
  );
}
