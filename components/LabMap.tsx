"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Campus site map drawn from the supplied `arl.geojson`.
 *
 * The file carries one polygon per facility (campus, RTA, MHE, OPG, OWT,
 * housing) plus a point for each of the 100 RTA dishes. We project
 * equirectangularly around the campus latitude — over a 2 km site the error is
 * far below a pixel — and fit the result to a fixed viewBox.
 */

type Position = [number, number];

interface MapFeature {
  id?: string;
  properties: { id?: string; name?: string; service?: string; radius_m?: number };
  geometry:
    | { type: "Polygon"; coordinates: Position[][] }
    | { type: "Point"; coordinates: Position };
}

interface MapData {
  features: MapFeature[];
}

const PAD = 18;
const W = 640;
const H = 420;

/** Polygons that make up the campus proper (context rings and off-site stations are skipped). */
const SITE_SERVICES = new Set(["arl", "rta", "mhe", "opg", "owt", "housing"]);

const SITE_STYLE: Record<string, { fill: string; stroke: string }> = {
  rta: { fill: "rgba(255, 201, 120, 0.10)", stroke: "#ffc978" },
  mhe: { fill: "rgba(255, 122, 69, 0.12)", stroke: "#ff7a45" },
  opg: { fill: "rgba(138, 180, 255, 0.12)", stroke: "#8ab4ff" },
  owt: { fill: "rgba(168, 146, 133, 0.12)", stroke: "#a89285" },
  housing: { fill: "rgba(232, 200, 164, 0.10)", stroke: "#e8c8a4" },
  arl: { fill: "rgba(255, 122, 69, 0.03)", stroke: "rgba(232, 200, 164, 0.35)" },
};

const LABEL_OFFSET: Record<string, { dx?: number; dy?: number }> = {
  rta: { dy: -6 },
  mhe: { dy: -6 },
  opg: { dy: -6 },
  owt: { dy: 14 },
  housing: { dy: -6 },
};

interface Projected {
  sites: Array<{ id: string; name: string; service: string; path: string; cx: number; cy: number }>;
  campus: string | null;
  dishes: Array<{ id: string; x: number; y: number }>;
}

function project(data: MapData): Projected | null {
  const polys = data.features.filter(
    (feature) =>
      feature.geometry.type === "Polygon" &&
      SITE_SERVICES.has(String(feature.properties.service ?? "")),
  );
  const points = data.features.filter(
    (feature) =>
      feature.geometry.type === "Point" && feature.properties.service === "rta",
  );
  if (polys.length === 0) return null;

  const all: Position[] = [];
  for (const feature of polys) {
    if (feature.geometry.type !== "Polygon") continue;
    for (const ring of feature.geometry.coordinates) all.push(...ring);
  }
  for (const feature of points) {
    if (feature.geometry.type === "Point") all.push(feature.geometry.coordinates);
  }

  const lat0 = all.reduce((sum, [, lat]) => sum + lat, 0) / all.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);

  const flat = all.map(([lon, lat]) => [lon * kx, lat] as Position);
  const xs = flat.map(([x]) => x);
  const ys = flat.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offsetX = PAD + ((W - PAD * 2) - spanX * scale) / 2;
  const offsetY = PAD + ((H - PAD * 2) - spanY * scale) / 2;

  // Screen y grows downward, latitude grows northward.
  const px = (lon: number) => offsetX + (lon * kx - minX) * scale;
  const py = (lat: number) => offsetY + (maxY - lat) * scale;

  const sites: Projected["sites"] = [];
  let campus: string | null = null;

  for (const feature of polys) {
    if (feature.geometry.type !== "Polygon") continue;
    const service = String(feature.properties.service ?? "");
    const id = String(feature.properties.id ?? feature.id ?? service);
    const ring = feature.geometry.coordinates[0] ?? [];
    if (ring.length < 3) continue;
    const path =
      ring
        .map(([lon, lat], index) => `${index === 0 ? "M" : "L"}${px(lon).toFixed(1)},${py(lat).toFixed(1)}`)
        .join(" ") + " Z";
    let sx = 0;
    let sy = 0;
    for (const [lon, lat] of ring) {
      sx += px(lon);
      sy += py(lat);
    }
    const site = {
      id,
      name: String(feature.properties.name ?? id),
      service,
      path,
      cx: sx / ring.length,
      cy: sy / ring.length,
    };
    if (service === "arl") campus = path;
    else sites.push(site);
  }

  const dishes = points.flatMap((feature) => {
    if (feature.geometry.type !== "Point") return [];
    const [lon, lat] = feature.geometry.coordinates;
    return [{ id: String(feature.properties.id ?? ""), x: px(lon), y: py(lat) }];
  });

  return { sites, campus, dishes };
}

export function LabMap({
  highlight,
  className = "",
}: {
  /** Service whose footprint should be emphasised, e.g. `"rta"`. */
  highlight?: string;
  className?: string;
}) {
  const [data, setData] = useState<Projected | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/arl.geojson");
        if (!response.ok) throw new Error(`arl.geojson → HTTP ${response.status}`);
        const parsed = project((await response.json()) as MapData);
        if (!cancelled) setData(parsed);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const legend = useMemo(
    () =>
      data?.sites
        .filter((site) => SITE_STYLE[site.service])
        .sort((a, b) => a.service.localeCompare(b.service)) ?? [],
    [data],
  );

  if (error) {
    return (
      <p className={`text-[11px] text-console-warn ${className}`}>
        Site map unavailable ({error}).
      </p>
    );
  }

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-lg border border-console-edge/70"
        role="img"
        aria-label="ARL campus site map"
      >
        <defs>
          {/* Regolith ground: cold at the top, ember haze along the horizon. */}
          <linearGradient id="regolith" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0b0809" />
            <stop offset="62%" stopColor="#140e0d" />
            <stop offset="100%" stopColor="#2a1712" />
          </linearGradient>
          <radialGradient id="horizonGlow" cx="50%" cy="100%" r="70%">
            <stop offset="0%" stopColor="#ff7a45" stopOpacity="0.22" />
            <stop offset="55%" stopColor="#8c3b21" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#8c3b21" stopOpacity="0" />
          </radialGradient>
          <filter id="dishGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect x={0} y={0} width={W} height={H} fill="url(#regolith)" />
        <rect x={0} y={0} width={W} height={H} fill="url(#horizonGlow)" />

        {/* Survey grid, drawn as faint dashed meridians. */}
        {Array.from({ length: 9 }, (_, index) => (
          <line
            key={`grid-${index}`}
            x1={PAD}
            y1={PAD + ((H - PAD * 2) / 8) * index}
            x2={W - PAD}
            y2={PAD + ((H - PAD * 2) / 8) * index}
            stroke="rgba(232, 200, 164, 0.07)"
            strokeWidth={1}
            strokeDasharray="2 6"
          />
        ))}

        {data?.campus && (
          <path
            d={data.campus}
            fill="none"
            stroke="rgba(232, 200, 164, 0.28)"
            strokeDasharray="5 5"
            strokeLinejoin="round"
          />
        )}

        {data?.sites.map((site) => {
          const style = SITE_STYLE[site.service] ?? SITE_STYLE.arl;
          const emphasised = highlight === site.service;
          const offset = LABEL_OFFSET[site.service] ?? {};
          return (
            <g key={site.id}>
              <path
                d={site.path}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={emphasised ? 2.2 : 1.2}
                strokeOpacity={emphasised ? 1 : 0.65}
                strokeLinejoin="round"
              />
              <text
                x={site.cx + (offset.dx ?? 0)}
                y={site.cy + (offset.dy ?? 0)}
                textAnchor="middle"
                className="font-mono"
                fontSize={emphasised ? 11 : 10}
                fill={emphasised ? style.stroke : "rgba(232, 200, 164, 0.55)"}
                letterSpacing={1.2}
              >
                {site.service.toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* The array: one spark per dish, glowing like a point of light. */}
        <g filter="url(#dishGlow)">
          {data?.dishes.map((dish) => (
            <circle key={dish.id} cx={dish.x} cy={dish.y} r={1.15} fill="#ffc978" fillOpacity={0.9} />
          ))}
        </g>

        {/* Cartographic furniture: north arrow and a 200 m scale bar. */}
        {data && (
          <>
            <g transform={`translate(${W - 30} 30)`} opacity={0.7}>
              <path d="M0 -10 L4 6 L0 2 L-4 6 Z" fill="#e8c8a4" fillOpacity={0.8} />
              <text x={0} y={16} textAnchor="middle" fontSize={8} fill="#a89285" className="font-mono">
                N
              </text>
            </g>
            <g transform={`translate(${PAD} ${H - 10})`} opacity={0.6}>
              <line x1={0} y1={0} x2={52} y2={0} stroke="#e8c8a4" strokeWidth={1.5} />
              <line x1={0} y1={-3} x2={0} y2={3} stroke="#e8c8a4" strokeWidth={1.5} />
              <line x1={52} y1={-3} x2={52} y2={3} stroke="#e8c8a4" strokeWidth={1.5} />
              <text x={56} y={3} fontSize={8} fill="#a89285" className="font-mono">
                200 m
              </text>
            </g>
          </>
        )}

        {!data && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="#a89285" className="font-mono">
            Surveying campus geometry…
          </text>
        )}
      </svg>

      {legend.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-console-muted">
          {legend.map((site) => (
            <span key={site.id} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: SITE_STYLE[site.service]?.stroke }}
              />
              {site.service}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-console-solar" />
            {data?.dishes.length ?? 0} dishes
          </span>
        </div>
      )}
    </div>
  );
}
