// Feeds the dashboard's radar charts (issue #7 + follow-up corrections): two groups, each its own
// collapsible section on the dashboard --
//
// - "seasonality": angle axis = calendar month, aggregated across every year the user has logged (a
//   January dive from 2023 and one from 2026 land in the same bucket -- this is a seasonality view,
//   not a timeline).
// - "distributions": angle axis = a value range (numeric properties bucketed into fixed-size steps)
//   or a value itself (the three ordinal intensity fields), radius = how many dives fall in it.

import type { DiveRecord } from "@/lib/dives";
import { computeGasConsumption } from "@/lib/gas-consumption";

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Matches dive-form.tsx's INTENSITIES order -- kept as a separate constant here rather than
// importing from that (client) component, since this module is also used server-side and in tests.
const INTENSITY_ORDER = ["None", "Mild", "Moderate", "Strong"];

type MonthlyRadarPoint = { month: string; value: number | null };
type MonthlyMinMaxAvgPoint = { month: string; min: number | null; max: number | null; avg: number | null };
type WaterTempRadarPoint = { month: string; high: number | null; low: number | null };
type BucketPoint = { bucket: string; count: number };
type IntensityPoint = { level: string; count: number };

type MonthlyRadarSeries = { data: MonthlyRadarPoint[]; domain: [number, number] };
type MonthlyMinMaxAvgSeries = { data: MonthlyMinMaxAvgPoint[]; domain: [number, number] };
type BucketSeries = { data: BucketPoint[]; domain: [number, number] };
type IntensitySeries = { data: IntensityPoint[]; domain: [number, number] };

export type DiveRadarStats = {
  seasonality: {
    divesPerMonth: MonthlyRadarSeries;
    depthPerMonth: MonthlyRadarSeries;
    durationPerMonth: MonthlyRadarSeries;
    visibilityPerMonth: MonthlyMinMaxAvgSeries;
    waterTempPerMonth: { data: WaterTempRadarPoint[]; domain: [number, number] };
    sacRatePerMonth: MonthlyMinMaxAvgSeries;
  };
  distributions: {
    depth: BucketSeries;
    duration: BucketSeries;
    visibility: BucketSeries;
    sacRate: BucketSeries;
    waves: IntensitySeries;
    surge: IntensitySeries;
    current: IntensitySeries;
  };
};

// numeric(_, _) columns come back from `pg` as strings; bottom_time_minutes is a plain integer
// column and already a number. Both pass through Number() cleanly.
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// +10% headroom so the outermost data point never touches the radar's rim -- matches issue #7's
// "0..{max+10%}" spec for depth/SAC rate, extended to every other magnitude chart for the same reason.
function withHeadroom(max: number): [number, number] {
  return [0, max > 0 ? max * 1.1 : 1];
}

function groupByMonth(dives: DiveRecord[]): DiveRecord[][] {
  const byMonth: DiveRecord[][] = Array.from({ length: 12 }, () => []);
  for (const dive of dives) {
    byMonth[new Date(dive.occurred_at).getMonth()].push(dive);
  }
  return byMonth;
}

function monthlySeries(
  byMonth: DiveRecord[][],
  extract: (dive: DiveRecord) => number | null,
): { data: MonthlyRadarPoint[]; values: number[] } {
  const data: MonthlyRadarPoint[] = [];
  const values: number[] = [];

  byMonth.forEach((group, index) => {
    const monthValues = group.map(extract).filter((value): value is number => value !== null);
    data.push({ month: MONTH_LABELS[index], value: average(monthValues) });
    values.push(...monthValues);
  });

  return { data, values };
}

function monthlyMinMaxAvgSeries(
  byMonth: DiveRecord[][],
  extract: (dive: DiveRecord) => number | null,
): { data: MonthlyMinMaxAvgPoint[]; values: number[] } {
  const data: MonthlyMinMaxAvgPoint[] = [];
  const values: number[] = [];

  byMonth.forEach((group, index) => {
    const monthValues = group.map(extract).filter((value): value is number => value !== null);
    data.push({
      month: MONTH_LABELS[index],
      min: monthValues.length ? Math.min(...monthValues) : null,
      max: monthValues.length ? Math.max(...monthValues) : null,
      avg: average(monthValues),
    });
    values.push(...monthValues);
  });

  return { data, values };
}

function diveSacRate(dive: DiveRecord): number | null {
  const result = computeGasConsumption({
    startPressure: toNumber(dive.start_pressure),
    endPressure: toNumber(dive.end_pressure),
    cylinderSize: toNumber(dive.cylinder_size),
    avgDepth: toNumber(dive.avg_depth),
    bottomTimeMinutes: dive.bottom_time_minutes,
  });
  return result?.sacRateLitersPerMin ?? null;
}

// Buckets a numeric property into fixed-size steps (e.g. depth in 5m steps: "0", "5", "10", ...),
// one bucket per `step` up to whichever bucket the largest observed value falls into. Each bucket's
// label is its lower bound, and its radius is how many dives landed in [label, label+step).
function numericDistribution(dives: DiveRecord[], extract: (dive: DiveRecord) => number | null, step: number): BucketSeries {
  const values = dives.map(extract).filter((value): value is number => value !== null && value >= 0);

  if (values.length === 0) {
    return { data: [{ bucket: "0", count: 0 }], domain: withHeadroom(0) };
  }

  const bucketCount = Math.floor(Math.max(...values) / step) + 1;
  const counts = Array.from({ length: bucketCount }, () => 0);
  for (const value of values) {
    counts[Math.min(bucketCount - 1, Math.floor(value / step))] += 1;
  }

  return {
    data: counts.map((count, index) => ({ bucket: String(index * step), count })),
    domain: withHeadroom(Math.max(...counts)),
  };
}

// One bucket per ordinal level (None/Mild/Moderate/Strong), radius = how many dives recorded that
// exact value. Dives that never recorded the field are excluded rather than folded into "None" --
// "not recorded" and "recorded as none" are different facts.
function intensityDistribution(dives: DiveRecord[], extract: (dive: DiveRecord) => string | null): IntensitySeries {
  const counts = INTENSITY_ORDER.map((level) => ({
    level,
    count: dives.filter((dive) => extract(dive) === level).length,
  }));

  return { data: counts, domain: withHeadroom(Math.max(...counts.map((point) => point.count))) };
}

export function buildDiveRadarStats(dives: DiveRecord[]): DiveRadarStats {
  const byMonth = groupByMonth(dives);

  const divesPerMonth = MONTH_LABELS.map((month, index) => ({
    month,
    value: byMonth[index].length,
  }));
  const divesPerMonthMax = Math.max(0, ...divesPerMonth.map((point) => point.value));

  const depth = monthlySeries(byMonth, (dive) => toNumber(dive.max_depth));
  const duration = monthlySeries(byMonth, (dive) => dive.bottom_time_minutes);
  const visibility = monthlyMinMaxAvgSeries(byMonth, (dive) => toNumber(dive.visibility));
  const waterTempHigh = monthlySeries(byMonth, (dive) => toNumber(dive.water_temp));
  const waterTempLow = monthlySeries(byMonth, (dive) => toNumber(dive.water_temp_low));
  const sacRate = monthlyMinMaxAvgSeries(byMonth, diveSacRate);

  const waterTempData: WaterTempRadarPoint[] = MONTH_LABELS.map((month, index) => ({
    month,
    high: waterTempHigh.data[index].value,
    low: waterTempLow.data[index].value,
  }));
  const waterTempMax = Math.max(0, ...waterTempHigh.values, ...waterTempLow.values);

  return {
    seasonality: {
      divesPerMonth: { data: divesPerMonth, domain: withHeadroom(divesPerMonthMax) },
      depthPerMonth: { data: depth.data, domain: withHeadroom(Math.max(0, ...depth.values)) },
      // Issue #7's explicit duration scale: 5 minutes .. longest dive + 15 minutes.
      durationPerMonth: {
        data: duration.data,
        domain: [5, Math.max(5, ...duration.values) + 15],
      },
      visibilityPerMonth: { data: visibility.data, domain: withHeadroom(Math.max(0, ...visibility.values)) },
      waterTempPerMonth: { data: waterTempData, domain: withHeadroom(waterTempMax) },
      sacRatePerMonth: { data: sacRate.data, domain: withHeadroom(Math.max(0, ...sacRate.values)) },
    },
    distributions: {
      depth: numericDistribution(dives, (dive) => toNumber(dive.max_depth), 5),
      duration: numericDistribution(dives, (dive) => dive.bottom_time_minutes, 10),
      visibility: numericDistribution(dives, (dive) => toNumber(dive.visibility), 5),
      sacRate: numericDistribution(dives, diveSacRate, 5),
      waves: intensityDistribution(dives, (dive) => dive.waves),
      surge: intensityDistribution(dives, (dive) => dive.surge),
      current: intensityDistribution(dives, (dive) => dive.current),
    },
  };
}
