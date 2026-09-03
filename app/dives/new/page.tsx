import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DiveForm } from "@/components/dive-form";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Log a dive · Dives",
};

export default async function NewDivePage() {
  const user = await requireUser("/dives/new");

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/dives"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Logbook
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Log a dive</h1>
        </div>

        <DiveForm />
      </div>
    </AppShell>
  );
}
