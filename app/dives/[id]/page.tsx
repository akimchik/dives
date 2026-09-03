import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil, Star } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DeleteDiveButton } from "@/components/delete-dive-button";
import { DepthProfileChart } from "@/components/depth-profile-chart";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isDepthProfile } from "@/lib/depth-profile";
import {
  formatDiveDate,
  formatDiveTime,
  formatMeasurement,
  formatMinutes,
} from "@/lib/dive-format";
import { getDive } from "@/lib/dives";
import { requireUser } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Dive · Dives",
};

function DetailGroup({
  title,
  entries,
}: {
  title: string;
  entries: [label: string, value: string | null][];
}) {
  // A group whose every field was left blank is noise, not information -- drop it entirely rather
  // than rendering a card full of em dashes.
  if (entries.every(([, value]) => value === null)) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm tabular-nums">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default async function DiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const diveId = Number(id);
  const user = await requireUser(`/dives/${id}`);

  if (!Number.isInteger(diveId)) notFound();

  const dive = await getDive(user.id, diveId);

  if (!dive) notFound();

  const siteName = dive.site_name ?? "Unnamed site";
  const label = `${siteName} on ${formatDiveDate(dive.occurred_at)}`;
  // The JSONB column is `unknown` to TypeScript and nothing stops a hand-edited row, so it is
  // narrowed with the parser's own guard rather than cast.
  const profile = isDepthProfile(dive.depth_profile) ? dive.depth_profile : null;

  const coordinates =
    dive.site_lat !== null && dive.site_lng !== null
      ? `${dive.site_lat}, ${dive.site_lng}`
      : null;

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Link
              href="/dives"
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> Logbook
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">{siteName}</h1>
            <p className="text-sm text-muted-foreground">
              {formatDiveDate(dive.occurred_at)} · {formatDiveTime(dive.occurred_at)}
              {dive.site_location ? ` · ${dive.site_location}` : ""}
            </p>
            {dive.rating !== null ? (
              <p className="flex items-center gap-0.5 pt-1" aria-label={`Rated ${dive.rating} out of 5`}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    aria-hidden
                    className={cn(
                      "size-4",
                      star <= dive.rating!
                        ? "fill-foreground text-foreground"
                        : "text-muted-foreground/40",
                    )}
                  />
                ))}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Link
              href={`/dives/${dive.id}/edit`}
              className={cn(buttonVariants({ variant: "outline" }), "no-underline")}
            >
              <Pencil /> Edit
            </Link>
            <DeleteDiveButton diveId={dive.id} label={label} />
          </div>
        </div>

        <DetailGroup
          title="Profile"
          entries={[
            ["Max depth", formatMeasurement(dive.max_depth, " m")],
            ["Average depth", formatMeasurement(dive.avg_depth, " m")],
            ["Bottom time", formatMinutes(dive.bottom_time_minutes)],
            ["Water temp", formatMeasurement(dive.water_temp, " °C")],
            ["Visibility", formatMeasurement(dive.visibility, " m")],
            ["Entry type", dive.entry_type],
          ]}
        />

        <DetailGroup
          title="Gear & gas"
          entries={[
            ["Gas mix", dive.gas_mix],
            ["Cylinder", dive.tank_info],
            ["Weight", formatMeasurement(dive.weight, " kg")],
            ["Suit", dive.suit_type],
          ]}
        />

        <DetailGroup
          title="Conditions & company"
          entries={[
            ["Current", dive.current],
            ["Surge", dive.surge],
            ["Weather", dive.weather],
            ["Buddy / dive guide", dive.buddy],
            ["Dive shop", dive.dive_shop],
            ["Site coordinates", coordinates],
          ]}
        />

        {dive.notes ? (
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">{dive.notes}</p>
            </CardContent>
          </Card>
        ) : null}

        {profile ? (
          <Card>
            <CardHeader>
              <CardTitle>Depth profile</CardTitle>
            </CardHeader>
            <CardContent>
              <DepthProfileChart points={profile} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}
