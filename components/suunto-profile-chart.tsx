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

type SeriesKey = "depth" | "temperature" | "tankPressure" | "gasConsumption";

// Each stream has its own scale (metres vs °C vs bar), so rather than overlay them as differently
// scaled area fills, a toggle switches which single stream the gradient area chart shows -- shadcn's
// Area Chart - Gradient (https://ui.shadcn.com/charts/area#chart-area-gradient) plus a
// https://ui.shadcn.com/docs/components/base/toggle -style switcher.
const SERIES: { key: SeriesKey; label: string; unit: string; color: string }[] = [
  { key: "depth", label: "Depth", unit: "m", color: "#0ea5e9" },
  { key: "temperature", label: "Temp", unit: "°C", color: "#f97316" },
  { key: "tankPressure", label: "Pressure", unit: "bar", color: "#10b981" },
  { key: "gasConsumption", label: "Gas used", unit: "bar", color: "#8b5cf6" },
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
  const [active, setActive] = useState<SeriesKey | null>(null);

  if (points.length < 2 || available.length === 0) return null;

  const activeSeries = available.find((series) => series.key === active) ?? available[0];
  const gradientId = `suuntoFill-${activeSeries.key}`;

  const data = points.map((point) => ({
    time: point.time,
    value: typeof point[activeSeries.key] === "number" ? point[activeSeries.key] : null,
  }));

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      {available.length > 1 ? (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={activeSeries.key}
          onValueChange={(value) => {
            if (value) setActive(value as SeriesKey);
          }}
          className="flex-wrap justify-start"
        >
          {available.map((series) => (
            <ToggleGroupItem key={series.key} value={series.key} aria-label={`Show ${series.label}`}>
              {series.label} ({series.unit})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      <ChartContainer
        config={chartConfig}
        className="aspect-[2.5/1] w-full"
        data-testid="suunto-profile-chart"
      >
        <AreaChart data={data} margin={{ left: 12, right: 12, top: 12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${activeSeries.key})`} stopOpacity={0.5} />
              <stop offset="95%" stopColor={`var(--color-${activeSeries.key})`} stopOpacity={0.05} />
            </linearGradient>
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
          <YAxis
            reversed={activeSeries.key === "depth"}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={44}
            domain={activeSeries.key === "depth" ? [0, "dataMax"] : ["auto", "auto"]}
          />
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
          <Area
            dataKey="value"
            name={activeSeries.key}
            type="monotone"
            fill={`url(#${gradientId})`}
            stroke={`var(--color-${activeSeries.key})`}
            strokeWidth={2}
            connectNulls
          />
        </AreaChart>
      </ChartContainer>
    </figure>
  );
}
