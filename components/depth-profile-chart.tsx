"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { DepthPoint } from "@/lib/depth-profile";
import { cn } from "@/lib/utils";

// shadcn's Area Chart - Gradient (https://ui.shadcn.com/charts/area#chart-area-gradient), backed by
// recharts. The dive form imports the same component for its live preview.

const chartConfig = {
  depth: { label: "Depth", color: "var(--foreground)" },
} satisfies ChartConfig;

export function DepthProfileChart({
  points,
  className,
}: {
  points: DepthPoint[];
  className?: string;
}) {
  const gradientId = `depthFill-${useId().replace(/:/g, "")}`;

  if (points.length < 2) return null;

  const maxTime = Math.round(Math.max(...points.map((point) => point.time)));
  const maxDepth = Math.round(Math.max(...points.map((point) => point.depth)) * 10) / 10;
  const summary = `Depth profile: ${points.length} points over ${maxTime} minutes, reaching ${maxDepth} metres.`;

  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <ChartContainer
        config={chartConfig}
        className="aspect-[2.5/1] w-full"
        data-testid="depth-profile-chart"
        // No role="img" here: that would mark the subtree presentational to assistive tech and
        // defeat accessibilityLayer below, which makes individual data points keyboard-navigable.
        // aria-label alone still gives screen readers a name for the chart as a whole.
        aria-label={summary}
      >
        <AreaChart accessibilityLayer data={points} margin={{ left: 12, right: 12, top: 12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-depth)" stopOpacity={0.5} />
              <stop offset="95%" stopColor="var(--color-depth)" stopOpacity={0.05} />
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
          {/* Reversed so depth grows downward, exactly as a dive-computer trace reads: the surface
              is the top edge and the deepest point hangs lowest. */}
          <YAxis
            reversed
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={40}
            domain={[0, "dataMax"]}
            tickFormatter={(value: number) => `${Math.round(value)}m`}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                // ChartTooltipContent's `labelFormatter` isn't handed the raw axis value here --
                // for a non-categorical (numeric time) x-axis its `value` resolves to the series
                // config label instead (see components/ui/chart.tsx), so pull the real time
                // straight off the hovered point's payload.
                labelFormatter={(_, payload) => `${Math.round(Number(payload?.[0]?.payload?.time ?? 0))} min`}
              />
            }
          />
          <Area
            dataKey="depth"
            type="monotone"
            fill={`url(#${gradientId})`}
            stroke="var(--color-depth)"
            strokeWidth={2}
          />
        </AreaChart>
      </ChartContainer>
      <figcaption id="dive-bookmark-scope-caption" className="text-xs text-muted-foreground">
        {points.length} samples · depth in metres against elapsed minutes · reaching {maxDepth}m over{" "}
        {maxTime} min
      </figcaption>
    </figure>
  );
}
