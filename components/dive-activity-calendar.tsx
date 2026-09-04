"use client";

import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DailyDiveCount } from "@/lib/dives";

// Dependency-free inline SVG (no chart library) -- same convention as DepthProfileChart. A
// GitHub-style contribution grid, one row per calendar year (Jan 1 - Dec 31, most recent on top)
// rather than a rolling 52-week block, so each row reads as an actual year.
// Sequential encoding (dive count -> one hue, light to dark) uses this app's own --primary token
// at increasing opacity rather than a separate literal palette, so it stays correct in both themes
// automatically instead of needing its own dark-mode ramp.

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const WEEKDAY_LABEL_COLUMN = 24;
const MONTH_ROW_HEIGHT = 16;
const ROW_HEIGHT = MONTH_ROW_HEIGHT + 7 * STEP;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Deliberately not `date.toISOString().slice(0, 10)` -- that converts to UTC first, which shifts
// every key back a day in any timezone ahead of UTC (a local midnight Date becomes the previous
// day once serialized), silently misplacing every cell relative to the calendar it's drawn on.
function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// Bucket boundaries fit a personal logbook's scale (most days 0, a dive day is often 1-4) rather
// than GitHub's commit-count buckets, which would be far too coarse here.
function bucketFor(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}

const BUCKET_CLASS: Record<0 | 1 | 2 | 3, string> = {
  0: "fill-muted",
  1: "fill-foreground/25",
  2: "fill-foreground/55",
  3: "fill-foreground/90",
};

const RANGE_ALL = "all";

// "All" needs the true span of the data rather than a fixed count, so the grid reaches back
// exactly to the calendar year of the first logged dive.
function yearRowCount(range: string, activity: DailyDiveCount[], today: Date): number {
  if (range !== RANGE_ALL) {
    return Number(range);
  }
  if (activity.length === 0) return 1;
  const earliestYear = new Date(activity[0].date).getFullYear();
  return Math.max(1, today.getFullYear() - earliestYear + 1);
}

function rangeLabel(range: string): string {
  if (range === RANGE_ALL) return "of all time";
  const years = Number(range);
  return years === 1 ? "over the last year" : `over the last ${years} years`;
}

type CalendarRow = { year: number; weeks: Date[][] };

// One row per calendar year, Sunday-aligned so weekday rows line up across every column --
// gridStart is the Sunday on/before Jan 1, gridEnd the Saturday on/after Dec 31, so the row
// covers the full year even though its edge weeks dip into the adjacent years.
function buildYearRow(year: number): CalendarRow {
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const gridStart = new Date(jan1);
  gridStart.setDate(gridStart.getDate() - jan1.getDay());
  const gridEnd = new Date(dec31);
  gridEnd.setDate(gridEnd.getDate() + (6 - dec31.getDay()));

  const totalDays = Math.round((gridEnd.getTime() - gridStart.getTime()) / DAY_MS) + 1;
  const weekCount = totalDays / 7;

  const weeks: Date[][] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const days: Date[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(gridStart);
      date.setDate(date.getDate() + week * 7 + weekday);
      days.push(date);
    }
    weeks.push(days);
  }

  return { year, weeks };
}

function CalendarRowGrid({
  row,
  today,
  countByDate,
}: {
  row: CalendarRow;
  today: Date;
  countByDate: Map<string, number>;
}) {
  const monthLabels: { week: number; label: string }[] = [];
  let lastMonth = -1;
  row.weeks.forEach((days, week) => {
    // A boundary week can dip into the adjacent year (e.g. the first column of 2026 also holds
    // late-Dec-2025 days) -- only look at the days that actually belong to this row's year, so
    // that week isn't mislabeled with the neighboring year's month.
    const dayInYear = days.find((day) => day.getFullYear() === row.year);
    if (!dayInYear) return;
    const month = dayInYear.getMonth();
    if (month !== lastMonth) {
      monthLabels.push({ week, label: MONTH_NAMES[month] });
      lastMonth = month;
    }
  });

  const width = WEEKDAY_LABEL_COLUMN + row.weeks.length * STEP;

  return (
    <div className="flex items-start gap-2">
      <span className="w-9 shrink-0 pt-4 text-right text-xs tabular-nums text-muted-foreground">
        {row.year}
      </span>
      <svg
        viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
        width={width}
        height={ROW_HEIGHT}
        role="presentation"
        aria-hidden
      >
        {monthLabels.map(({ week, label }) => (
          <text
            key={`${week}-${label}`}
            x={WEEKDAY_LABEL_COLUMN + week * STEP}
            y={MONTH_ROW_HEIGHT - 5}
            className="fill-muted-foreground text-[10px]"
          >
            {label}
          </text>
        ))}

        {["Mon", "Wed", "Fri"].map((label) => {
          const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
          return (
            <text
              key={label}
              x={0}
              y={MONTH_ROW_HEIGHT + weekday * STEP + CELL - 2}
              className="fill-muted-foreground text-[9px]"
            >
              {label}
            </text>
          );
        })}

        {row.weeks.map((days, week) =>
          days.map((date, weekday) => {
            if (date > today) return null;

            const key = toDateKey(date);
            const count = countByDate.get(key) ?? 0;

            return (
              <rect
                key={key}
                x={WEEKDAY_LABEL_COLUMN + week * STEP}
                y={MONTH_ROW_HEIGHT + weekday * STEP}
                width={CELL}
                height={CELL}
                rx={2}
                className={BUCKET_CLASS[bucketFor(count)]}
              >
                <title>
                  {count === 0
                    ? `No dives on ${key}`
                    : `${count} ${count === 1 ? "dive" : "dives"} on ${key}`}
                </title>
              </rect>
            );
          }),
        )}
      </svg>
    </div>
  );
}

export function DiveActivityCalendar({
  activity,
  maxYears,
}: {
  activity: DailyDiveCount[];
  maxYears: number;
}) {
  const [range, setRange] = useState<string>("1");
  const countByDate = new Map(activity.map((day) => [day.date, day.count]));

  const today = startOfDay(new Date());
  const rowCount = yearRowCount(range, activity, today);
  const currentYear = today.getFullYear();

  const rows = Array.from({ length: rowCount }, (_, index) => buildYearRow(currentYear - index));
  const oldestRow = rows[rows.length - 1];
  const rangeStartKey = toDateKey(oldestRow.weeks[0][0]);
  const totalDives = activity
    .filter((day) => day.date >= rangeStartKey)
    .reduce((sum, day) => sum + day.count, 0);

  const yearOptions = Array.from({ length: maxYears }, (_, index) => String(index + 1));

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger aria-label="Activity calendar range" className="h-8 w-auto text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={RANGE_ALL}>All</SelectItem>
            {yearOptions.map((year) => (
              <SelectItem key={year} value={year}>
                {year === "1" ? "1 year" : `${year} years`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div
        className="flex flex-col gap-3 overflow-x-auto"
        role="img"
        aria-label={`Dive activity ${rangeLabel(range)}: ${totalDives} ${totalDives === 1 ? "dive" : "dives"} logged.`}
      >
        {rows.map((row) => (
          <CalendarRowGrid key={row.year} row={row} today={today} countByDate={countByDate} />
        ))}
      </div>

      <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Less
        {([0, 1, 2, 3] as const).map((bucket) => (
          <svg key={bucket} width={CELL} height={CELL} aria-hidden>
            <rect width={CELL} height={CELL} rx={2} className={BUCKET_CLASS[bucket]} />
          </svg>
        ))}
        More
      </figcaption>
    </figure>
  );
}
