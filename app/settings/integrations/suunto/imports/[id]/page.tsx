import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DeleteSuuntoImportButton } from "@/components/delete-suunto-import-button";
import { DiveForm } from "@/components/dive-form";
import { SuuntoProfileChart } from "@/components/suunto-profile-chart";
import { Card, CardContent } from "@/components/ui/card";
import { getPendingSuuntoImport } from "@/lib/suunto/imports";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Review Suunto dive · Dives",
};

export default async function ReviewSuuntoImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const importId = Number(id);
  const user = await requireUser(`/settings/integrations/suunto/imports/${id}`);

  if (!Number.isInteger(importId)) notFound();

  const pending = await getPendingSuuntoImport(user.id, importId);
  if (!pending || pending.id !== importId) notFound();

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/settings/integrations"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Integrations
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Review Suunto dive</h1>
          <p className="text-sm text-muted-foreground">
            {pending.remaining_count} fetched {pending.remaining_count === 1 ? "dive" : "dives"} still in the edit queue.
          </p>
          <DeleteSuuntoImportButton importId={pending.id} />
        </div>

        <Card className="border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
          <CardContent className="px-4 text-sm">
            Review and edit the imported fields, then save it as a normal dive. This dive will keep
            Suunto workout id <span className="font-mono">{pending.workout_key}</span> and can be
            uploaded to PADI later.
          </CardContent>
        </Card>

        <Card>
          <CardContent className="px-4">
            <SuuntoProfileChart profile={pending.compiled_profile} />
          </CardContent>
        </Card>

        <DiveForm
          draftDive={pending.draft_dive}
          suuntoImportId={pending.id}
          cancelHref="/settings/integrations"
          submitLabel="Save Suunto dive"
        />
      </div>
    </AppShell>
  );
}
