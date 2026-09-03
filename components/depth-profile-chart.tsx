import type { DepthPoint } from "@/lib/depth-profile";
import { cn } from "@/lib/utils";

// Deliberately a dependency-free inline SVG rather than a charting library: the plan asks for "a
// simple line chart", and hand-rolled SVG keeps this a plain (non-"use client") component, so the
// dive detail page renders the profile on the server with no chart bundle shipped to the browser.
// The dive form imports the same component for its live preview.

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 240;
const PADDING = { top: 12, right: 12, bottom: 24, left: 40 };

const PLOT_WIDTH = VIEW_WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const step = value <= 10 ? 2 : value <= 40 ? 5 : 10;
  return Math.ceil(value / step) * step;
}

export function DepthProfileChart({
  points,
  className,
}: {
  points: DepthPoint[];
  className?: string;
}) {
  if (points.length < 2) return null;

  const maxTime = Math.max(...points.map((point) => point.time), 1);
  const maxDepth = niceCeiling(Math.max(...points.map((point) => point.depth)));

  // y grows downward exactly as depth does, so the profile reads like a dive-computer trace: the
  // surface is the top edge and the deepest point hangs lowest. No axis inversion needed.
  const x = (time: number) => PADDING.left + (time / maxTime) * PLOT_WIDTH;
  const y = (depth: number) => PADDING.top + (depth / maxDepth) * PLOT_HEIGHT;

  const line = points.map((point) => `${x(point.time)},${y(point.depth)}`).join(" ");
  const area = `${PADDING.left},${PADDING.top} ${line} ${x(maxTime)},${PADDING.top}`;

  const depthTicks = [0, maxDepth / 2, maxDepth];

  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`Depth profile: ${points.length} points over ${Math.round(maxTime)} minutes, reaching ${Math.max(...points.map((p) => p.depth))} metres.`}
        data-testid="depth-profile-chart"
      >
        {depthTicks.map((depth) => (
          <g key={depth}>
            <line
              x1={PADDING.left}
              x2={VIEW_WIDTH - PADDING.right}
              y1={y(depth)}
              y2={y(depth)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={y(depth) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {Math.round(depth)}m
            </text>
          </g>
        ))}

        <polygon points={area} className="fill-foreground/8" />
        <polyline
          points={line}
          fill="none"
          className="stroke-foreground"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <text
          x={PADDING.left}
          y={VIEW_HEIGHT - 4}
          className="fill-muted-foreground text-[11px] tabular-nums"
        >
          0m
        </text>
        <text
          x={VIEW_WIDTH - PADDING.right}
          y={VIEW_HEIGHT - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[11px] tabular-nums"
        >
          {Math.round(maxTime)} min
        </text>
      </svg>
      <figcaption className="text-xs text-muted-foreground">
        {points.length} samples · depth in metres against elapsed minutes
      </figcaption>
    </figure>
  );
}
