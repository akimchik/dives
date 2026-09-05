import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { DiveSitesManager, type DiveSiteListItem } from "@/components/dive-sites-manager";
import { listDiveSitesWithDiveCounts } from "@/lib/dives";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Dive Sites · Dives",
};

export default async function DiveSitesPage() {
  const user = await requireUser("/dive-sites");
  const sites = await listDiveSitesWithDiveCounts(user.id);

  const items: DiveSiteListItem[] = sites.map((site) => ({
    id: site.id,
    name: site.name,
    location: site.location,
    lat: site.lat,
    lng: site.lng,
    createdAt: site.created_at.toISOString(),
    diveCount: site.dive_count,
  }));

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dive Sites</h1>
          <p className="text-sm text-muted-foreground">
            Manage saved dive sites, fix details, and merge duplicates without losing dive logs.
          </p>
        </div>

        <DiveSitesManager initialSites={items} />
      </div>
    </AppShell>
  );
}
