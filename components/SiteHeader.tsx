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
  { href: "/lwm", label: "LWM" },
  { href: "/alerts", label: "Alerts" },
];

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
    <header className="sticky top-0 z-40 border-b border-console-edge/80 bg-console-void/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-console-signal/50 bg-console-signal/10 font-mono text-xs font-bold text-console-signal">
            AR
          </span>
          <span className="leading-tight">
            <span className="block text-[13px] font-semibold uppercase tracking-[0.18em] text-console-ink">
              ARL Control
            </span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-console-muted">
              Astro-Research Laboratory
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                  active
                    ? "bg-console-grid text-console-signal"
                    : "text-console-muted hover:bg-console-grid/60 hover:text-console-ink"
                }`}
              >
                {link.label}
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
          <span className="font-mono text-xs tabular-nums text-console-muted">{clock}</span>
        </div>
      </div>

      <Link
        href="/alerts"
        className={`block border-t transition-colors ${
          stripTone === "alert"
            ? "border-console-alert/60 bg-console-alert/15 hover:bg-console-alert/20"
            : stripTone === "warn"
              ? "border-console-warn/50 bg-console-warn/10 hover:bg-console-warn/15"
              : "border-console-edge/60 bg-console-void/60 hover:bg-console-grid/40"
        }`}
      >
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 text-[11px]">
          <span
            className={`flex items-center gap-1.5 font-semibold uppercase tracking-[0.16em] ${
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
                  <span className="font-mono uppercase tracking-[0.12em] text-console-info">
                    {alerts.newest.service}
                  </span>{" "}
                  {alerts.newest.message}
                </span>
              )}
              <span className="ml-auto hidden shrink-0 font-mono uppercase tracking-[0.14em] text-console-signal sm:inline">
                open alert log →
              </span>
            </>
          )}
        </div>
      </Link>
    </header>
  );
}
