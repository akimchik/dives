import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { BackupDivesButton } from "@/components/backup-dives-button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Settings · Dives",
};

export default async function SettingsPage() {
  const user = await requireUser("/settings");

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Manage your logbook and its data.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col items-start gap-4 px-4">
            <h2 className="text-sm font-medium">Backup</h2>
            <BackupDivesButton />
            <p className="text-xs text-muted-foreground">
              Downloads everything stored for your dives as a single zip: your dives, dive sites and
              bookmarks as JSON, plus the original Suunto export files for every dive imported from a
              Suunto watch.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-2 px-4">
            <h2 className="text-sm font-medium">Integrations</h2>
            <p className="text-xs text-muted-foreground">
              Connect PADI and Suunto, and import dives from them.
            </p>
            <Link href="/settings/integrations" className="w-fit text-sm">
              Manage integrations
            </Link>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
