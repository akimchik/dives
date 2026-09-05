import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { PadiConnectForm } from "@/components/padi-connect-form";
import { getPadiIntegrationStatus } from "@/lib/padi/integrations";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Integrations · Dives",
};

export default async function IntegrationsPage() {
  const user = await requireUser("/settings/integrations");
  const status = await getPadiIntegrationStatus(user.id);

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
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="text-sm text-muted-foreground">Connect other services to your logbook.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 px-4">
            <h2 className="text-sm font-medium">PADI</h2>
            <PadiConnectForm
              status={
                status ? { status: status.status, connectedAt: status.connectedAt.toISOString() } : null
              }
            />
            <p className="text-xs text-muted-foreground">
              PADI sync imports new remote dives and flags linked recreational dives whose local
              copy differs from PADI. To replace a local linked dive with PADI’s version, delete the
              local dive and run Sync PADI again.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
