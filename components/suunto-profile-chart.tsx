import type { SuuntoDiveProfile } from "@/lib/suunto/profile";
import { cn } from "@/lib/utils";

const VIEW_WIDTH = 760;
const VIEW_HEIGHT = 320;
const PADDING = { top: 16, right: 52, bottom: 30, left: 44 };
const PLOT_WIDTH = VIEW_WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

type SeriesKey = "depth" | "temperature" | "tankPressure" | "gasConsumption";

const SERIES: { key: SeriesKey; label: string; unit: string; className: string; dotClassName: string }[] = [
  { key: "depth", label: "Depth", unit: "m", className: "stroke-sky-500", dotClassName: "bg-sky-500" },
  {
    key: "temperature",
    label: "Temp",
    unit: "°C",
    className: "stroke-orange-500",
    dotClassName: "bg-orange-500",
  },
  {
    key: "tankPressure",
    label: "Pressure",
    unit: "bar",
    className: "stroke-emerald-500",
    dotClassName: "bg-emerald-500",
  },
  {
    key: "gasConsumption",
    label: "Gas used",
    unit: "bar",
    className: "stroke-violet-500",
    dotClassName: "bg-violet-500",
  },
];

function values(profile: SuuntoDiveProfile, key: SeriesKey): number[] {
  return profile.points.flatMap((point) => {
    const value = point[key];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
}

function ceiling(value: number): number {
  if (value <= 0) return 1;
  const step = value <= 10 ? 2 : value <= 50 ? 5 : 25;
  return Math.ceil(value / step) * step;
}

function lineFor(profile: SuuntoDiveProfile, key: SeriesKey, maxTime: number, maxValue: number): string {
  return profile.points
    .flatMap((point) => {
      const value = point[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return [];
      const x = PADDING.left + (point.time / maxTime) * PLOT_WIDTH;
      const y = PADDING.top + (value / maxValue) * PLOT_HEIGHT;
      return [`${x},${y}`];
    })
    .join(" ");
}

export function SuuntoProfileChart({
  profile,
  className,
}: {
  profile: SuuntoDiveProfile;
  className?: string;
}) {
  if (profile.points.length < 2) return null;

  const maxTime = Math.max(...profile.points.map((point) => point.time), 1);
  const scales = new Map<SeriesKey, number>();
  for (const series of SERIES) {
    const seriesValues = values(profile, series.key);
    if (seriesValues.length > 0) scales.set(series.key, ceiling(Math.max(...seriesValues)));
  }

  const depthMax = scales.get("depth") ?? 1;
  const yDepth = (depth: number) => PADDING.top + (depth / depthMax) * PLOT_HEIGHT;
  const depthTicks = [0, depthMax / 2, depthMax];

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`Suunto dive profile: ${profile.points.length} samples over ${Math.round(maxTime)} minutes.`}
        data-testid="suunto-profile-chart"
      >
        {depthTicks.map((depth) => (
          <g key={depth}>
            <line
              x1={PADDING.left}
              x2={VIEW_WIDTH - PADDING.right}
              y1={yDepth(depth)}
              y2={yDepth(depth)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={yDepth(depth) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {Math.round(depth)}m
            </text>
          </g>
        ))}

        {SERIES.map((series) => {
          const scale = scales.get(series.key);
          if (!scale) return null;
          const points = lineFor(profile, series.key, maxTime, scale);
          if (!points) return null;
          return (
            <polyline
              key={series.key}
              points={points}
              fill="none"
              className={series.className}
              strokeWidth={series.key === "depth" ? 2.5 : 1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        <text x={PADDING.left} y={VIEW_HEIGHT - 6} className="fill-muted-foreground text-[11px] tabular-nums">
          0 min
        </text>
        <text
          x={VIEW_WIDTH - PADDING.right}
          y={VIEW_HEIGHT - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[11px] tabular-nums"
        >
          {Math.round(maxTime)} min
        </text>
        <text
          x={VIEW_WIDTH - 4}
          y={PADDING.top + 4}
          textAnchor="end"
          className="fill-muted-foreground text-[11px] tabular-nums"
        >
          own scales
        </text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {SERIES.map((series) =>
          scales.has(series.key) ? (
            <span key={series.key} className="inline-flex items-center gap-1">
              <span className={cn("inline-block size-2 rounded-full", series.dotClassName)} />
              {series.label} ({series.unit})
            </span>
          ) : null,
        )}
      </figcaption>
    </figure>
  );
}
