// Shared SAC-rate helpers for the dashboard's summary stats and the dive detail page's per-dive
// comparison -- both need the same per-dive rate lib/dive-radar-stats.ts already derives for its
// radar charts, plus a couple of small aggregates that module has no reason to own.

import type { DiveRecord } from "@/lib/dives";
import { computeGasConsumption } from "@/lib/gas-consumption";

// numeric(_, _) columns come back from `pg` as strings; bottom_time_minutes is a plain integer
// column and already a number. Both pass through Number() cleanly.
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** A dive's SAC rate, or null if it's missing any of the fields the formula needs. */
export function diveSacRate(dive: DiveRecord): number | null {
  const result = computeGasConsumption({
    startPressure: toNumber(dive.start_pressure),
    endPressure: toNumber(dive.end_pressure),
    cylinderSize: toNumber(dive.cylinder_size),
    avgDepth: toNumber(dive.avg_depth),
    bottomTimeMinutes: dive.bottom_time_minutes,
  });
  return result?.sacRateLitersPerMin ?? null;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Linear-interpolation percentile (the common/numpy-default method); null on an empty input. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];

  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}
