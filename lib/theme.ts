/**
 * The palette, for the places that cannot use a Tailwind class: `<canvas>`
 * drawing, inline SVG and the few CSS custom properties the panels expose.
 *
 * Keep this in step with `tailwind.config.ts`. The names match the semantic
 * tokens (`signal`, `solar`, `alert`, …) so a component reads the same whether
 * it is styled with a class or a literal colour.
 */
export const THEME = {
  void: "#07060c",
  panel: "#140f0d",
  edge: "#33231d",
  grid: "#1d1512",
  ink: "#f6ece1",
  muted: "#a89285",
  signal: "#ff7a45",
  solar: "#ffc978",
  alert: "#ff4b3e",
  warn: "#ffa14b",
  ok: "#5fd39b",
  info: "#8ab4ff",
  rust: "#8c3b21",
  sand: "#e8c8a4",
} as const;

/**
 * One accent per console, so a panel or a chip identifies its service at a
 * glance: gold for the array looking at the sky, ember for the habitat, plasma
 * blue for the power plant.
 */
export const SERVICE_ACCENT = {
  RTA: THEME.solar,
  MHE: THEME.signal,
  OPG: THEME.info,
  LWM: THEME.muted,
} as const;
