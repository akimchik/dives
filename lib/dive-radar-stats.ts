// Feeds the dashboard's "seasonality" radar charts (issue #7): one shape per property, angle axis
// = calendar month, aggregated across every year the user has logged (a January dive from 2023 and
// one from 2026 land in the same bucket -- this is a seasonality view, not a timeline).

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
const MAX_INTENSITY_SCORE = INTENSITY_ORDER.length - 1;
const MAX_RATING = 5;

type MonthlyRadarPoint = { month: string; value: number | null };
type WaterTempRadarPoint = { month: string; high: number | null; low: number | null };
type ConditionsRadarPoint = { metric: string; value: number | null; raw: string | null };

type MonthlyRadarSeries = { data: MonthlyRadarPoint[]; domain: [number, number] };

export type DiveRadarStats = {
  divesPerMonth: MonthlyRadarSeries;
  depthPerMonth: MonthlyRadarSeries;
  durationPerMonth: MonthlyRadarSeries;
  visibilityPerMonth: MonthlyRadarSeries;
  waterTempPerMonth: { data: WaterTempRadarPoint[]; domain: [number, number] };
  sacRatePerMonth: MonthlyRadarSeries;
  conditions: { data: ConditionsRadarPoint[]; domain: [number, number] };
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
// "0..{max+10%}" spec for depth/SAC rate, extended to visibility/water-temp for the same reason.
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

function intensityScore(value: string | null): number | null {
  if (value === null) return null;
  const index = INTENSITY_ORDER.indexOf(value);
  return index === -1 ? null : index;
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
  const visibility = monthlySeries(byMonth, (dive) => toNumber(dive.visibility));
  const waterTempHigh = monthlySeries(byMonth, (dive) => toNumber(dive.water_temp));
  const waterTempLow = monthlySeries(byMonth, (dive) => toNumber(dive.water_temp_low));
  const sacRate = monthlySeries(byMonth, diveSacRate);

  const waterTempData: WaterTempRadarPoint[] = MONTH_LABELS.map((month, index) => ({
    month,
    high: waterTempHigh.data[index].value,
    low: waterTempLow.data[index].value,
  }));
  const waterTempMax = Math.max(0, ...waterTempHigh.values, ...waterTempLow.values);

  // "Conditions & company" props, excluding buddy/dive shop (identity, not a magnitude) and site
  // coordinates (not part of that card). Weather/water type/body of water are also left out: they're
  // nominal categories (a name, not an amount), so there's no meaningful position for them on a
  // radius axis. What's left -- current/surge/waves (ordinal intensity), air temp and rating -- each
  // gets normalised to a 0-100% share of its own scale so five different units can share one radius.
  const currentScores = dives.map((d) => intensityScore(d.current)).filter((v): v is number => v !== null);
  const surgeScores = dives.map((d) => intensityScore(d.surge)).filter((v): v is number => v !== null);
  const wavesScores = dives.map((d) => intensityScore(d.waves)).filter((v): v is number => v !== null);
  const ratings = dives.map((d) => d.rating).filter((v): v is number => v !== null);
  const airTemps = dives
    .map((d) => toNumber(d.air_temp))
    .filter((v): v is number => v !== null);
  const airTempMax = Math.max(0, ...airTemps);

  const avgCurrent = average(currentScores);
  const avgSurge = average(surgeScores);
  const avgWaves = average(wavesScores);
  const avgRating = average(ratings);
  const avgAirTemp = average(airTemps);

  const pctOf = (value: number | null, max: number): number | null =>
    value === null || max <= 0 ? null : (value / max) * 100;

  const conditions: ConditionsRadarPoint[] = [
    { metric: "Current", value: pctOf(avgCurrent, MAX_INTENSITY_SCORE), raw: avgCurrent === null ? null : INTENSITY_ORDER[Math.round(avgCurrent)] },
    { metric: "Surge", value: pctOf(avgSurge, MAX_INTENSITY_SCORE), raw: avgSurge === null ? null : INTENSITY_ORDER[Math.round(avgSurge)] },
    { metric: "Waves", value: pctOf(avgWaves, MAX_INTENSITY_SCORE), raw: avgWaves === null ? null : INTENSITY_ORDER[Math.round(avgWaves)] },
    { metric: "Air temp", value: pctOf(avgAirTemp, airTempMax), raw: avgAirTemp === null ? null : `${avgAirTemp.toFixed(1)}°C` },
    { metric: "Rating", value: pctOf(avgRating, MAX_RATING), raw: avgRating === null ? null : `${avgRating.toFixed(1)}/5` },
  ];

  return {
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
    conditions: { data: conditions, domain: [0, 100] },
  };
}
