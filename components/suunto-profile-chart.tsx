"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SuuntoDiveProfilePoint } from "@/lib/suunto/profile";
import { cn } from "@/lib/utils";

type SeriesKey = "depth" | "temperature" | "tankPressure" | "gasConsumption" | "gasConsumptionRate";

// Each stream has its own scale (metres vs °C vs bar), so multiple selected streams each get their
// own (mostly hidden) y-axis rather than sharing one -- shadcn's Area Chart - Gradient
// (https://ui.shadcn.com/charts/area#chart-area-gradient) plus a multi-select
// https://ui.shadcn.com/docs/components/base/toggle -style switcher. Only one y-axis (the "depth"
// stream if it's selected, otherwise whichever is first) is drawn, so picking several streams at
// once doesn't clutter the chart with parallel axes -- the tooltip still reports every selected
// stream's real value at the hovered time.
const SERIES: { key: SeriesKey; label: string; unit: string; color: string }[] = [
  { key: "depth", label: "Depth", unit: "m", color: "#0ea5e9" },
  { key: "temperature", label: "Temp", unit: "°C", color: "#f97316" },
  { key: "tankPressure", label: "Pressure", unit: "bar", color: "#10b981" },
  { key: "gasConsumption", label: "Gas used", unit: "bar", color: "#8b5cf6" },
  { key: "gasConsumptionRate", label: "Consumption rate", unit: "bar/min", color: "#ec4899" },
];

const chartConfig = Object.fromEntries(
  SERIES.map((series) => [series.key, { label: series.label, color: series.color }]),
) satisfies ChartConfig;

function hasValues(points: SuuntoDiveProfilePoint[], key: SeriesKey): boolean {
  return points.some((point) => {
    const value = point[key];
    return typeof value === "number" && Number.isFinite(value);
  });
}

function formatWithUnit(value: number, unit: string): string {
  if (unit === "bar/min") return `${value.toFixed(1)} ${unit}`;
  const rounded = Math.round(value);
  return unit === "bar" ? `${rounded} bar` : `${rounded}${unit}`;
}

// Takes just the points, not the whole SuuntoDiveProfile: this is a client component, and Next.js
// serializes every field of a client-component prop into the page (it doesn't tree-shake unread
// ones) -- the rest of the profile carries the raw Suunto summary blob, including a
// non-workout-scoped GPS fix that lib/suunto/profile.ts's own derived `location` deliberately
// excludes from ever being attributed to a dive (see the "Trust only workout-scoped Suunto
// coordinates" commit). Shipping that blob to the browser just because a chart needed depth/temp/
// pressure/gas would undo that guarantee.
export function SuuntoProfileChart({
  points,
  className,
}: {
  points: SuuntoDiveProfilePoint[];
  className?: string;
}) {
  const available = useMemo(() => SERIES.filter((series) => hasValues(points, series.key)), [points]);
  const [active, setActive] = useState<SeriesKey[]>([]);

  if (points.length < 2 || available.length === 0) return null;

  const selectedKeys = active.filter((key) => available.some((series) => series.key === key));
  const activeSeries = selectedKeys.length > 0 ? available.filter((series) => selectedKeys.includes(series.key)) : [available[0]];
  const primary = activeSeries.find((series) => series.key === "depth") ?? activeSeries[0];
  const maxTime = Math.round(Math.max(...points.map((point) => point.time)));

  const data = points.map((point) => {
    const row: { time: number } & Partial<Record<SeriesKey, number | null>> = { time: point.time };
    for (const series of activeSeries) {
      const raw = point[series.key];
      row[series.key] = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    }
    return row;
  });

  const captionLabel =
    activeSeries.length === 1
      ? `showing ${activeSeries[0].label.toLowerCase()} (${activeSeries[0].unit})`
      : `showing ${activeSeries.map((series) => series.label.toLowerCase()).join(", ")}`;

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      {available.length > 1 ? (
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={activeSeries.map((series) => series.key)}
          onValueChange={(value) => {
            if (value.length > 0) setActive(value as SeriesKey[]);
          }}
          className="flex-wrap justify-start"
        >
          {available.map((series) => (
            <ToggleGroupItem key={series.key} value={series.key} aria-label={`Toggle ${series.label}`}>
              <span
                className="mr-1.5 inline-block size-2 rounded-full"
                style={{ backgroundColor: series.color }}
                aria-hidden
              />
              {series.label} ({series.unit})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      <ChartContainer
        config={chartConfig}
        className="aspect-[2.5/1] w-full"
        data-testid="suunto-profile-chart"
        // No role="img": see the matching comment in depth-profile-chart.tsx -- it would defeat
        // accessibilityLayer's keyboard-navigable data points below.
        aria-label={`Suunto dive profile: ${points.length} samples over ${maxTime} minutes, ${captionLabel}.`}
      >
        <AreaChart accessibilityLayer data={data} margin={{ left: 12, right: 12, top: 12 }}>
          <defs>
            {activeSeries.map((series) => (
              <linearGradient key={series.key} id={`suuntoFill-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor={`var(--color-${series.key})`}
                  stopOpacity={activeSeries.length > 1 ? 0.25 : 0.5}
                />
                <stop offset="95%" stopColor={`var(--color-${series.key})`} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            domain={[0, "dataMax"]}
            tickFormatter={(value: number) => `${Math.round(value)} min`}
          />
          {activeSeries.map((series) => (
            <YAxis
              key={series.key}
              yAxisId={series.key}
              orientation="left"
              hide={series.key !== primary.key}
              reversed={series.key === "depth"}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={series.key === primary.key ? 56 : 0}
              domain={series.key === "depth" ? [0, "dataMax"] : ["auto", "auto"]}
              tickFormatter={(value: number) => formatWithUnit(value, series.unit)}
            />
          ))}
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                // See the matching comment in depth-profile-chart.tsx: `value` here isn't the raw
                // axis value for a numeric x-axis, so read the real time off the payload instead.
                labelFormatter={(_, payload) => `${Math.round(Number(payload?.[0]?.payload?.time ?? 0))} min`}
              />
            }
          />
          {activeSeries.map((series) => (
            <Area
              key={series.key}
              yAxisId={series.key}
              dataKey={series.key}
              type="monotone"
              fill={`url(#suuntoFill-${series.key})`}
              stroke={`var(--color-${series.key})`}
              strokeWidth={2}
              connectNulls
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <figcaption className="text-xs text-muted-foreground">
        {points.length} samples · {captionLabel}
      </figcaption>
    </figure>
  );
}
