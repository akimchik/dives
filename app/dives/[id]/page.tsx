import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil, Star } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { CreatePadiDiveButton } from "@/components/create-padi-dive-button";
import { DeleteDiveButton } from "@/components/delete-dive-button";
import { DepthProfileChart } from "@/components/depth-profile-chart";
import { DiveSiteMap } from "@/components/dive-site-map-lazy";
import { SuuntoProfileChart } from "@/components/suunto-profile-chart";
import { UpdatePadiDiveButton } from "@/components/update-padi-dive-button";
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
import { computeGasConsumption } from "@/lib/gas-consumption";
import { getPadiIntegrationStatus } from "@/lib/padi/integrations";
import { requireUser } from "@/lib/session";
import { isSuuntoDiveProfile } from "@/lib/suunto/profile";
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

// "Hood, gloves" reads better than three mostly-empty boolean rows in the same dl grid the rest
// of this page uses, and disappears entirely (like every other optional field here) when none
// were worn rather than showing three "No"s.
function wornExtras(dive: { hood: boolean | null; gloves: boolean | null; boots: boolean | null }) {
  const worn = [
    dive.hood ? "Hood" : null,
    dive.gloves ? "Gloves" : null,
    dive.boots ? "Boots" : null,
  ].filter((item): item is string => item !== null);

  return worn.length > 0 ? worn.join(", ") : null;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function DiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const diveId = Number(id);
  const user = await requireUser(`/dives/${id}`);

  if (!Number.isInteger(diveId)) notFound();

  const [dive, padiIntegration] = await Promise.all([
    getDive(user.id, diveId),
    getPadiIntegrationStatus(user.id),
  ]);

  if (!dive) notFound();

  const siteName = dive.site_name ?? "Unnamed site";
  const heading = dive.title ?? siteName;
  const label = `${siteName} on ${formatDiveDate(dive.occurred_at)}`;
  // The JSONB column is `unknown` to TypeScript and nothing stops a hand-edited row, so it is
  // narrowed with the parser's own guard rather than cast.
  const profile = isDepthProfile(dive.depth_profile) ? dive.depth_profile : null;
  const suuntoProfile = isSuuntoDiveProfile(dive.suunto_profile) ? dive.suunto_profile : null;
  const canUpdatePadi =
    dive.padi_needs_update &&
    dive.padi_dive_id !== null &&
    dive.log_type === "Recreational" &&
    dive.log_course === null &&
    padiIntegration?.status === "connected";

  const coordinates =
    dive.site_lat !== null && dive.site_lng !== null
      ? `${dive.site_lat}, ${dive.site_lng}`
      : null;

  // Never stored -- re-derived from the stored pressures/cylinder/depth/time every time it's
  // shown, so it can never drift from what those fields actually say.
  const gasConsumption = computeGasConsumption({
    startPressure: toNumber(dive.start_pressure),
    endPressure: toNumber(dive.end_pressure),
    cylinderSize: toNumber(dive.cylinder_size),
    avgDepth: toNumber(dive.avg_depth),
    bottomTimeMinutes: dive.bottom_time_minutes,
  });

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
            <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            <p className="text-sm text-muted-foreground">
              {formatDiveDate(dive.occurred_at)} · {formatDiveTime(dive.occurred_at)}
              {dive.title ? ` · ${siteName}` : ""}
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
            {dive.padi_dive_id === null && padiIntegration?.status === "connected" ? (
              <CreatePadiDiveButton diveId={dive.id} />
            ) : null}
            {canUpdatePadi ? <UpdatePadiDiveButton diveId={dive.id} /> : null}
            <Link
              href={`/dives/${dive.id}/edit`}
              className={cn(buttonVariants({ variant: "outline" }), "no-underline")}
            >
              <Pencil /> Edit
            </Link>
            <DeleteDiveButton diveId={dive.id} label={label} />
          </div>
        </div>

        {dive.site_lat !== null && dive.site_lng !== null ? (
          <DiveSiteMap lat={dive.site_lat} lng={dive.site_lng} height={220} />
        ) : null}

        {canUpdatePadi ? (
          <Card className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <CardContent className="px-4 text-sm">
              This linked recreational dive differs from the latest PADI sync. Use “Update to PADI”
              to push this local version to PADI.
            </CardContent>
          </Card>
        ) : null}

        <DetailGroup
          title="Profile"
          entries={[
            ["Suunto workout id", dive.suunto_workout_key],
            ["Max depth", formatMeasurement(dive.max_depth, " m")],
            ["Average depth", formatMeasurement(dive.avg_depth, " m")],
            ["Bottom time", formatMinutes(dive.bottom_time_minutes)],
            ["Water temp — surface", formatMeasurement(dive.water_temp, " °C")],
            ["Water temp — lowest", formatMeasurement(dive.water_temp_low, " °C")],
            ["Visibility", formatMeasurement(dive.visibility, " m")],
            ["Entry type", dive.entry_type],
          ]}
        />

        <DetailGroup
          title="Gear & gas"
          entries={[
            ["Gas mix", dive.gas_mix],
            ["Cylinder", dive.tank_info],
            ["Cylinder size", formatMeasurement(dive.cylinder_size, " L")],
            ["Start pressure", formatMeasurement(dive.start_pressure, " bar")],
            ["End pressure", formatMeasurement(dive.end_pressure, " bar")],
            [
              "Gas used",
              gasConsumption ? `${gasConsumption.gasUsedLiters.toFixed(0)} L` : null,
            ],
            [
              "SAC rate",
              gasConsumption ? `${gasConsumption.sacRateLitersPerMin.toFixed(1)} L/min` : null,
            ],
            ["Weight", formatMeasurement(dive.weight, " kg")],
            ["Weighting", dive.weight_feedback],
            ["Suit", dive.suit_type],
            ["Also worn", wornExtras(dive)],
          ]}
        />

        <DetailGroup
          title="Conditions & company"
          entries={[
            ["Current", dive.current],
            ["Surge", dive.surge],
            ["Waves", dive.waves],
            ["Weather", dive.weather],
            ["Air temp", formatMeasurement(dive.air_temp, " °C")],
            ["Water type", dive.water_type],
            ["Body of water", dive.body_of_water],
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

        {suuntoProfile ? (
          <Card>
            <CardHeader>
              <CardTitle>Suunto profile</CardTitle>
            </CardHeader>
            <CardContent>
              <SuuntoProfileChart profile={suuntoProfile} />
            </CardContent>
          </Card>
        ) : profile ? (
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
