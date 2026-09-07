"use client";

import { ChevronDown } from "lucide-react";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DiveRadarStats } from "@/lib/dive-radar-stats";

// Colors are shared across every radar below, not chosen per-card, so the whole section reads as
// one system: blue is always "the average" (matching the single-series charts elsewhere on this
// dashboard), aqua is always "the low end", orange is always "the high end". All three are the
// dataviz palette's first three categorical slots, which validate together (all-pairs, not just
// adjacent) in both color modes.
const AVG = { light: "#2a78d6", dark: "#3987e5" };
const HIGH = { light: "#eb6834", dark: "#d95926" };
const LOW = { light: "#1baf7a", dark: "#199e70" };

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
          {/* outerRadius + margin leave enough room for the widest angle-axis labels ("Moderate",
              "Strong") not to clip against the card edge -- the default 80% radius only works for
              the three-letter month labels the shadcn example was built around. */}
          <RadarChart data={data} outerRadius="62%" margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
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

function RadarSection({
  title,
  testId,
  defaultOpen = true,
  children,
}: {
  title: string;
  testId: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} data-testid={testId}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-sm font-medium">
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Dashboard radar-chart sections for issue #7 and its follow-up corrections: "Seasonality" (angle
// axis = calendar month, aggregated across every year logged) and "Distributions" (angle axis = a
// value range or the value itself, radius = how many dives fall in it).
export function DiveRadarCharts({ stats }: { stats: DiveRadarStats }) {
  return (
    <div className="flex flex-col gap-5" data-testid="dive-radar-charts">
      <RadarSection title="Seasonality" testId="radar-section-seasonality">
        <RadarStatCard
          title="Dives per month"
          ariaLabel="Number of dives logged per calendar month"
          testId="radar-dives-per-month"
          config={{ value: { label: "Dives", theme: AVG } }}
          data={stats.seasonality.divesPerMonth.data}
          domain={stats.seasonality.divesPerMonth.domain}
          angleKey="month"
          seriesKeys={["value"]}
        />
        <RadarStatCard
          title="Depth by month"
          ariaLabel="Average maximum depth in metres per calendar month"
          testId="radar-depth-per-month"
          config={{ value: { label: "Avg depth (m)", theme: AVG } }}
          data={stats.seasonality.depthPerMonth.data}
          domain={stats.seasonality.depthPerMonth.domain}
          angleKey="month"
          seriesKeys={["value"]}
        />
        <RadarStatCard
          title="Duration by month"
          ariaLabel="Average bottom time in minutes per calendar month"
          testId="radar-duration-per-month"
          config={{ value: { label: "Avg duration (min)", theme: AVG } }}
          data={stats.seasonality.durationPerMonth.data}
          domain={stats.seasonality.durationPerMonth.domain}
          angleKey="month"
          seriesKeys={["value"]}
        />
        <RadarStatCard
          title="Visibility by month"
          ariaLabel="Minimum, maximum and average visibility in metres per calendar month"
          testId="radar-visibility-per-month"
          config={{
            min: { label: "Min (m)", theme: LOW },
            avg: { label: "Avg (m)", theme: AVG },
            max: { label: "Max (m)", theme: HIGH },
          }}
          data={stats.seasonality.visibilityPerMonth.data}
          domain={stats.seasonality.visibilityPerMonth.domain}
          angleKey="month"
          seriesKeys={["min", "avg", "max"]}
        />
        <RadarStatCard
          title="Water temp by month"
          ariaLabel="Average high and low water temperature in Celsius per calendar month"
          testId="radar-water-temp-per-month"
          config={{
            high: { label: "High (°C)", theme: HIGH },
            low: { label: "Low (°C)", theme: LOW },
          }}
          data={stats.seasonality.waterTempPerMonth.data}
          domain={stats.seasonality.waterTempPerMonth.domain}
          angleKey="month"
          seriesKeys={["high", "low"]}
        />
        <RadarStatCard
          title="SAC rate by month"
          ariaLabel="Minimum, maximum and average surface air consumption rate in litres per minute per calendar month"
          testId="radar-sac-rate-per-month"
          config={{
            min: { label: "Min (L/min)", theme: LOW },
            avg: { label: "Avg (L/min)", theme: AVG },
            max: { label: "Max (L/min)", theme: HIGH },
          }}
          data={stats.seasonality.sacRatePerMonth.data}
          domain={stats.seasonality.sacRatePerMonth.domain}
          angleKey="month"
          seriesKeys={["min", "avg", "max"]}
        />
      </RadarSection>

      <RadarSection title="Distributions" testId="radar-section-distributions">
        <RadarStatCard
          title="Dives by depth"
          ariaLabel="Number of dives per maximum-depth range, in 5 metre steps"
          testId="radar-distribution-depth"
          config={{ count: { label: "Dives", theme: AVG } }}
          data={stats.distributions.depth.data}
          domain={stats.distributions.depth.domain}
          angleKey="bucket"
          seriesKeys={["count"]}
        />
        <RadarStatCard
          title="Dives by duration"
          ariaLabel="Number of dives per bottom-time range, in 10 minute steps"
          testId="radar-distribution-duration"
          config={{ count: { label: "Dives", theme: AVG } }}
          data={stats.distributions.duration.data}
          domain={stats.distributions.duration.domain}
          angleKey="bucket"
          seriesKeys={["count"]}
        />
        <RadarStatCard
          title="Dives by visibility"
          ariaLabel="Number of dives per visibility range, in 5 metre steps"
          testId="radar-distribution-visibility"
          config={{ count: { label: "Dives", theme: AVG } }}
          data={stats.distributions.visibility.data}
          domain={stats.distributions.visibility.domain}
          angleKey="bucket"
          seriesKeys={["count"]}
        />
        <RadarStatCard
          title="Dives by SAC rate"
          ariaLabel="Number of dives per surface air consumption rate range, in 5 litres per minute steps"
          testId="radar-distribution-sac-rate"
          config={{ count: { label: "Dives", theme: AVG } }}
          data={stats.distributions.sacRate.data}
          domain={stats.distributions.sacRate.domain}
          angleKey="bucket"
          seriesKeys={["count"]}
        />
        <RadarStatCard
          title="Dives by current, surge & waves"
          ariaLabel="Number of dives per recorded intensity, for current, surge and waves"
          testId="radar-distribution-conditions"
          config={{
            current: { label: "Current", theme: AVG },
            surge: { label: "Surge", theme: HIGH },
            waves: { label: "Waves", theme: LOW },
          }}
          data={stats.distributions.conditions.data}
          domain={stats.distributions.conditions.domain}
          angleKey="level"
          seriesKeys={["current", "surge", "waves"]}
        />
      </RadarSection>
    </div>
  );
}
