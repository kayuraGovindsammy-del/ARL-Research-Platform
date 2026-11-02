"use client";

/**
 * The top of every service console.
 *
 * Same structure on all three pages — service number, name, the question the
 * console answers, then the live status chips — so an operator moving between
 * services only has to re-read the content, not the layout. The accent colour
 * is the service's own (gold for the array, ember for the habitat, plasma blue
 * for the plant).
 */
export function ServiceHeader({
  index,
  service,
  title,
  blurb,
  accent,
  status,
}: {
  index: string;
  service: string;
  title: string;
  blurb: React.ReactNode;
  accent: string;
  status?: React.ReactNode;
}) {
  return (
    <header className="relative overflow-hidden rounded-xl border border-console-edge/70 bg-console-panel/60 px-5 py-4 shadow-panel">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(600px 260px at 92% -55%, ${accent}33, transparent 72%)`,
        }}
      />
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: `linear-gradient(180deg, ${accent}, transparent 85%)` }}
      />

      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker" style={{ color: accent }}>
            Service {index} · {service}
          </p>
          <h1
            className="hero-title mt-1.5 text-[1.7rem] sm:text-[2rem]"
            style={{
              backgroundImage: `linear-gradient(100deg, #fdf5ec 6%, ${accent} 58%, ${accent}b3 100%)`,
            }}
          >
            {title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-console-muted">{blurb}</p>
        </div>
        {status && <div className="flex flex-wrap items-center gap-2">{status}</div>}
      </div>
    </header>
  );
}
