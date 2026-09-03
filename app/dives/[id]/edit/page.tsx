import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DeleteDiveButton } from "@/components/delete-dive-button";
import { DiveForm } from "@/components/dive-form";
import { formatDiveDate } from "@/lib/dive-format";
import { getDive } from "@/lib/dives";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Edit dive · Dives",
};

export default async function EditDivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const diveId = Number(id);
  const user = await requireUser(`/dives/${id}/edit`);

  if (!Number.isInteger(diveId)) notFound();

  // getDive is scoped by user_id, so another user's dive id resolves to null here and renders the
  // same not-found page as an id that doesn't exist at all -- the two are indistinguishable.
  const dive = await getDive(user.id, diveId);

  if (!dive) notFound();

  const label = `${dive.site_name ?? "Unnamed site"} on ${formatDiveDate(dive.occurred_at)}`;

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Link
              href={`/dives/${dive.id}`}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> Back to dive
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">Edit dive</h1>
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
          <DeleteDiveButton diveId={dive.id} label={label} />
        </div>

        <DiveForm dive={dive} />
      </div>
    </AppShell>
  );
}
