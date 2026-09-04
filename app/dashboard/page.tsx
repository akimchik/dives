import type { Metadata } from "next";
import Link from "next/link";
import { Gauge, MapPin, Plus, Timer, Waves } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DiveActivityCalendar } from "@/components/dive-activity-calendar";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatDiveDate,
  formatMeasurement,
  formatMinutes,
  trimNumeric,
} from "@/lib/dive-format";
import { getDiveActivityByDay, getDiveStats, listDives } from "@/lib/dives";
import { requireUser } from "@/lib/session";
import { cn } from "@/lib/utils";

// A week of slack past the calendar's own 52-week grid, so the Sunday-aligned start (which can
// land a few days before "52 weeks ago" depending on today's weekday) is never short a row.
function activityRange() {
  const to = new Date();
  to.setHours(24, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 53 * 7);
  return { from, to };
}

export const metadata: Metadata = {
  title: "Dashboard · Dives",
};

function Stat({
  icon: Icon,
  label,
  value,
  unit,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  unit?: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 px-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
        {/* The value carries its own test id so the e2e spec can assert on the number alone,
            without the unit suffix making the assertion brittle. */}
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          <span data-testid={testId}>{value}</span>
          {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
        </span>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const user = await requireUser("/dashboard");
  const [stats, dives, activity] = await Promise.all([
    getDiveStats(user.id),
    listDives(user.id),
    getDiveActivityByDay(user.id, activityRange()),
  ]);
  const recent = dives.slice(0, 5);

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">Your logbook at a glance.</p>
          </div>
          <Link href="/dives/new" className={cn(buttonVariants(), "no-underline")}>
            <Plus /> Log a dive
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            icon={Waves}
            label="Total dives"
            value={String(stats.totalDives)}
            testId="stat-total-dives"
          />
          <Stat
            icon={Timer}
            label="Total bottom time"
            value={formatMinutes(stats.totalBottomTimeMinutes) ?? "0m"}
            testId="stat-total-bottom-time"
          />
          <Stat
            icon={Gauge}
            label="Deepest dive"
            value={trimNumeric(stats.deepestDepth) ?? "—"}
            unit={stats.deepestDepth === null ? undefined : "m"}
            testId="stat-deepest-dive"
          />
          <Stat
            icon={MapPin}
            label="Sites visited"
            value={String(stats.distinctSites)}
            testId="stat-distinct-sites"
          />
        </div>

        <Card>
          <CardContent className="flex flex-col gap-3 px-4">
            <h2 className="text-sm font-medium">Activity</h2>
            <DiveActivityCalendar activity={activity} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium">Recent dives</h2>
            {dives.length > recent.length ? (
              <Link href="/dives" className="text-xs text-muted-foreground hover:text-foreground">
                View all {dives.length}
              </Link>
            ) : null}
          </div>

          {recent.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Nothing logged yet. Your first dive will show up here.
              </CardContent>
            </Card>
          ) : (
            <ol className="flex flex-col gap-2">
              {recent.map((dive) => (
                <li key={dive.id}>
                  <Link
                    href={`/dives/${dive.id}`}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-3 no-underline shadow-sm transition-colors hover:bg-accent/50"
                  >
                    <span className="min-w-0 flex-1 basis-48 truncate font-medium">
                      {dive.title ?? dive.site_name ?? "Unnamed site"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDiveDate(dive.occurred_at)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                      {formatMeasurement(dive.max_depth, "m") ?? "—"}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </AppShell>
  );
}
