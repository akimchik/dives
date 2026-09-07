import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { SuuntoRawPreview } from "@/components/suunto-raw-preview";
import { Card, CardContent } from "@/components/ui/card";
import { formatDiveDate, formatDiveTime } from "@/lib/dive-format";
import { getDive, getDiveSuuntoOriginalBundle } from "@/lib/dives";
import { requireUser } from "@/lib/session";
import { extractSmlJson } from "@/lib/suunto/raw-bundle";

export const metadata: Metadata = {
  title: "Raw Suunto data · Dives",
};

export default async function DiveRawSuuntoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const diveId = Number(id);
  const user = await requireUser(`/dives/${id}/raw`);

  if (!Number.isInteger(diveId)) notFound();

  const [dive, bundle] = await Promise.all([
    getDive(user.id, diveId),
    getDiveSuuntoOriginalBundle(user.id, diveId),
  ]);

  // Same not-found response whether the dive doesn't exist, belongs to another user, or simply
  // has no Suunto data -- none of those should be distinguishable from the URL alone.
  if (!dive || !bundle) notFound();

  const siteName = dive.site_name ?? "Unnamed site";
  const heading = dive.title ?? siteName;

  let raw: unknown = null;
  let parseError: string | null = null;
  try {
    raw = extractSmlJson(bundle.originalBundle);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href={`/dives/${dive.id}`}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> {heading}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Raw Suunto data</h1>
          <p className="text-sm text-muted-foreground">
            {formatDiveDate(dive.occurred_at)} · {formatDiveTime(dive.occurred_at)} · workout{" "}
            {bundle.workoutKey}
          </p>
        </div>

        {parseError ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              This dive&apos;s stored Suunto bundle couldn&apos;t be read as SML data ({parseError}).
            </CardContent>
          </Card>
        ) : (
          <SuuntoRawPreview data={raw} />
        )}
      </div>
    </AppShell>
  );
}
