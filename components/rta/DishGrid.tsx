"use client";

import { dishTone, type DishEntry } from "@/lib/rta-selectors";
import { formatNumber, titleCase } from "@/lib/format";

const TILE_CLASSES: Record<string, string> = {
  ok: "border-console-ok/40 bg-console-ok/10 text-console-ok hover:border-console-ok",
  warn: "border-console-warn/50 bg-console-warn/10 text-console-warn hover:border-console-warn",
  alert: "border-console-alert/60 bg-console-alert/15 text-console-alert hover:border-console-alert",
  neutral: "border-console-edge bg-console-grid/30 text-console-muted hover:border-console-muted",
};

/** 100-dish rack. Each tile is a button so the detail/control panel can drill in. */
export function DishGrid({
  dishes,
  selectedId,
  onSelect,
}: {
  dishes: DishEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-1 sm:grid-cols-10">
      {dishes.map((dish) => {
        const tone = dishTone(dish);
        const selected = dish.id === selectedId;
        const label = dish.id.replace(/^D-?/, "");
        const tooltip = [
          dish.id,
          dish.metrics ? titleCase(dish.condition) : "No telemetry",
          dish.temperatureC !== null ? `${formatNumber(dish.temperatureC)} °C` : null,
          dish.powerW !== null ? `${formatNumber(dish.powerW, 0)} W` : null,
          `sub-array ${dish.subArray}`,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <button
            key={dish.id}
            type="button"
            onClick={() => onSelect(dish.id)}
            title={tooltip}
            aria-pressed={selected}
            className={`flex h-11 flex-col items-center justify-center rounded border font-mono text-[10px] leading-tight transition-colors ${TILE_CLASSES[tone]} ${
              selected ? "ring-2 ring-console-signal/80" : ""
            }`}
          >
            <span className="font-semibold">{label}</span>
            <span className="text-[9px] opacity-80">
              {dish.temperatureC !== null ? `${Math.round(dish.temperatureC)}°` : "··"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
