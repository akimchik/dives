"use client";

import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { DiveRadarStats } from "@/lib/dive-radar-stats";

// Single hue for every one-series chart below: each radar is its own independent magnitude (not a
// category competing with the others for identity), so shadcn's "Radar Chart - Grid Circle" pattern
// reusing one brand hue reads as one coherent dashboard rather than an arbitrary rainbow.
const SEQUENTIAL = { light: "#2a78d6", dark: "#3987e5" };
// Warm/cool pair for the one two-series chart (water temp): blue reads "cold", orange reads "warm",
// and the pair clears the CVD/normal-vision separation gates in both color modes.
const WARM = { light: "#eb6834", dark: "#d95926" };
const COOL = SEQUENTIAL;

function RadarStatCard({
  title,
  ariaLabel,
  testId,
  config,
  data,
  domain,
  angleKey,
  seriesKeys,
}: {
  title: string;
  ariaLabel: string;
  testId: string;
  config: ChartConfig;
  data: Record<string, unknown>[];
  domain: [number, number];
  angleKey: string;
  seriesKeys: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={config}
          className="mx-auto aspect-square max-h-64 w-full"
          data-testid={testId}
          aria-label={ariaLabel}
        >
          <RadarChart data={data}>
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <PolarGrid gridType="circle" />
            <PolarAngleAxis dataKey={angleKey} />
            <PolarRadiusAxis domain={domain} axisLine={false} tick={false} />
            {seriesKeys.map((key) => (
              <Radar
                key={key}
                dataKey={key}
                stroke={`var(--color-${key})`}
                fill={`var(--color-${key})`}
                fillOpacity={0.4}
                strokeWidth={2}
                connectNulls
              />
            ))}
            {seriesKeys.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
          </RadarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// Dashboard "seasonality" section for issue #7: one radar per property from the dive log, angle
// axis = calendar month (aggregated across every year), so the shape traces how that property
// varies through the diving season.
export function DiveRadarCharts({ stats }: { stats: DiveRadarStats }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="dive-radar-charts">
      <RadarStatCard
        title="Dives per month"
        ariaLabel="Number of dives logged per calendar month"
        testId="radar-dives-per-month"
        config={{ value: { label: "Dives", theme: SEQUENTIAL } }}
        data={stats.divesPerMonth.data}
        domain={stats.divesPerMonth.domain}
        angleKey="month"
        seriesKeys={["value"]}
      />
      <RadarStatCard
        title="Depth by month"
        ariaLabel="Average maximum depth in metres per calendar month"
        testId="radar-depth-per-month"
        config={{ value: { label: "Avg depth (m)", theme: SEQUENTIAL } }}
        data={stats.depthPerMonth.data}
        domain={stats.depthPerMonth.domain}
        angleKey="month"
        seriesKeys={["value"]}
      />
      <RadarStatCard
        title="Duration by month"
        ariaLabel="Average bottom time in minutes per calendar month"
        testId="radar-duration-per-month"
        config={{ value: { label: "Avg duration (min)", theme: SEQUENTIAL } }}
        data={stats.durationPerMonth.data}
        domain={stats.durationPerMonth.domain}
        angleKey="month"
        seriesKeys={["value"]}
      />
      <RadarStatCard
        title="Visibility by month"
        ariaLabel="Average visibility in metres per calendar month"
        testId="radar-visibility-per-month"
        config={{ value: { label: "Avg visibility (m)", theme: SEQUENTIAL } }}
        data={stats.visibilityPerMonth.data}
        domain={stats.visibilityPerMonth.domain}
        angleKey="month"
        seriesKeys={["value"]}
      />
      <RadarStatCard
        title="Water temp by month"
        ariaLabel="Average high and low water temperature in Celsius per calendar month"
        testId="radar-water-temp-per-month"
        config={{
          high: { label: "High (°C)", theme: WARM },
          low: { label: "Low (°C)", theme: COOL },
        }}
        data={stats.waterTempPerMonth.data}
        domain={stats.waterTempPerMonth.domain}
        angleKey="month"
        seriesKeys={["high", "low"]}
      />
      <RadarStatCard
        title="SAC rate by month"
        ariaLabel="Average surface air consumption rate in litres per minute per calendar month"
        testId="radar-sac-rate-per-month"
        config={{ value: { label: "Avg SAC rate (L/min)", theme: SEQUENTIAL } }}
        data={stats.sacRatePerMonth.data}
        domain={stats.sacRatePerMonth.domain}
        angleKey="month"
        seriesKeys={["value"]}
      />
      <RadarStatCard
        title="Conditions & company"
        ariaLabel="Average dive conditions -- current, surge, waves, air temperature and rating -- each as a share of its own scale"
        testId="radar-conditions"
        config={{ value: { label: "% of scale", theme: SEQUENTIAL } }}
        data={stats.conditions.data}
        domain={stats.conditions.domain}
        angleKey="metric"
        seriesKeys={["value"]}
      />
    </div>
  );
}
