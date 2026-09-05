"use client";

import { useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Edit, GitMerge, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

import { mergeDiveSitesAction, updateDiveSiteAction } from "@/app/actions/dive-sites";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type DiveSiteListItem = {
  id: number;
  name: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
  diveCount: number;
};

type SiteFormState = {
  name: string;
  location: string;
  lat: string;
  lng: string;
};

type MergeField = keyof SiteFormState;

const DiveSiteMap = dynamic(
  () => import("@/components/dive-site-map").then((mod) => mod.DiveSiteMap),
  { ssr: false, loading: () => <div className="h-[220px] animate-pulse rounded-md border border-border bg-muted" /> },
);

const mergeFields: Array<{ key: MergeField; label: string }> = [
  { key: "name", label: "Name" },
  { key: "location", label: "Location" },
  { key: "lat", label: "Latitude" },
  { key: "lng", label: "Longitude" },
];

function siteToForm(site: DiveSiteListItem): SiteFormState {
  return {
    name: site.name,
    location: site.location ?? "",
    lat: site.lat === null ? "" : String(site.lat),
    lng: site.lng === null ? "" : String(site.lng),
  };
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInput(form: SiteFormState) {
  return {
    name: form.name.trim(),
    location: form.location.trim() || null,
    lat: optionalNumber(form.lat),
    lng: optionalNumber(form.lng),
  };
}

function displayCoordinate(site: DiveSiteListItem) {
  if (site.lat === null || site.lng === null) return "—";
  return `${site.lat}, ${site.lng}`;
}

function displayValue(site: DiveSiteListItem, key: MergeField) {
  if (key === "name") return site.name;
  if (key === "location") return site.location || "Empty";
  if (key === "lat") return site.lat === null ? "Empty" : String(site.lat);
  return site.lng === null ? "Empty" : String(site.lng);
}

function toListItem(site: {
  id: number;
  name: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  created_at?: Date;
  createdAt?: string;
  dive_count: number;
}): DiveSiteListItem {
  return {
    id: site.id,
    name: site.name,
    location: site.location,
    lat: site.lat,
    lng: site.lng,
    createdAt: site.createdAt ?? site.created_at?.toISOString() ?? new Date().toISOString(),
    diveCount: site.dive_count,
  };
}

export function DiveSitesManager({ initialSites }: { initialSites: DiveSiteListItem[] }) {
  const [sites, setSites] = useState(initialSites);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [editingSite, setEditingSite] = useState<DiveSiteListItem | null>(null);
  const [editForm, setEditForm] = useState<SiteFormState>({ name: "", location: "", lat: "", lng: "" });
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const [mergeChoices, setMergeChoices] = useState<Record<MergeField, number | null>>({
    name: null,
    location: null,
    lat: null,
    lng: null,
  });
  const [isPending, startTransition] = useTransition();

  const selectedSites = useMemo(
    () => selectedIds.map((id) => sites.find((site) => site.id === id)).filter((site): site is DiveSiteListItem => Boolean(site)),
    [selectedIds, sites],
  );
  const canMerge = selectedSites.length === 2;

  function toggleSelected(siteId: number, checked: boolean) {
    setSelectedIds((current) => {
      if (!checked) return current.filter((id) => id !== siteId);
      if (current.includes(siteId)) return current;
      return [...current, siteId].slice(-2);
    });
  }

  function openEdit(site: DiveSiteListItem) {
    setEditingSite(site);
    setEditForm(siteToForm(site));
  }

  function saveEdit() {
    if (!editingSite) return;

    startTransition(async () => {
      const result = await updateDiveSiteAction(editingSite.id, toInput(editForm));

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const updated = toListItem(result.site);
      setSites((current) => current.map((site) => (site.id === updated.id ? updated : site)));
      setEditingSite(null);
      toast.success(`Updated ${updated.name}.`);
    });
  }

  function setMergeTarget(siteId: number) {
    setMergeTargetId(siteId);
    setMergeChoices({ name: siteId, location: siteId, lat: siteId, lng: siteId });
  }

  function openMerge() {
    if (!canMerge) return;
    const [first] = selectedSites;
    setMergeTarget(first.id);
    setMergeOpen(true);
  }

  function saveMerge() {
    if (!canMerge || mergeTargetId === null) return;
    const fromSite = selectedSites.find((site) => site.id !== mergeTargetId);
    const intoSite = selectedSites.find((site) => site.id === mergeTargetId);
    if (!fromSite || !intoSite) return;

    const mergedForm: SiteFormState = { name: "", location: "", lat: "", lng: "" };
    for (const field of mergeFields) {
      const sourceId = mergeChoices[field.key] ?? mergeTargetId;
      const source = selectedSites.find((site) => site.id === sourceId) ?? intoSite;
      mergedForm[field.key] = siteToForm(source)[field.key];
    }

    startTransition(async () => {
      const result = await mergeDiveSitesAction({
        fromSiteId: fromSite.id,
        intoSiteId: intoSite.id,
        ...toInput(mergedForm),
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const updated = toListItem(result.site);
      setSites((current) => current.filter((site) => site.id !== fromSite.id).map((site) => (site.id === updated.id ? updated : site)));
      setSelectedIds([]);
      setMergeOpen(false);
      toast.success(`Merged ${fromSite.name} into ${updated.name}. ${result.movedDives} dive log${result.movedDives === 1 ? "" : "s"} moved.`);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-3">
        <p className="text-sm text-muted-foreground">
          Select two dive sites to merge duplicates. Merge updates existing dive logs to point at the result.
        </p>
        <Button type="button" disabled={!canMerge || isPending} onClick={openMerge} className="w-fit">
          <GitMerge /> Merge selected
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Select</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Coordinates</TableHead>
            <TableHead>Dives</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sites.map((site) => (
            <TableRow key={site.id} data-state={selectedIds.includes(site.id) ? "selected" : undefined}>
              <TableCell>
                <Checkbox
                  aria-label={`Select ${site.name}`}
                  checked={selectedIds.includes(site.id)}
                  onCheckedChange={(checked) => toggleSelected(site.id, checked === true)}
                />
              </TableCell>
              <TableCell className="font-medium">{site.name}</TableCell>
              <TableCell>{site.location || "—"}</TableCell>
              <TableCell>{displayCoordinate(site)}</TableCell>
              <TableCell>{site.diveCount}</TableCell>
              <TableCell className="text-right">
                <Button type="button" size="sm" variant="outline" onClick={() => openEdit(site)} disabled={isPending}>
                  <Edit /> Edit
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {sites.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                No dive sites yet. Create one while logging a dive.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <Dialog open={editingSite !== null} onOpenChange={(open) => !open && !isPending && setEditingSite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit dive site</DialogTitle>
            <DialogDescription>Update the saved site details used by your dive log entries.</DialogDescription>
          </DialogHeader>
          <SiteFields value={editForm} onChange={setEditForm} disabled={isPending} idPrefix="edit-site" />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => setEditingSite(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={isPending || !editForm.name.trim()} onClick={saveEdit}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Save site
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={(open) => !open && !isPending && setMergeOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Merge dive sites</DialogTitle>
            <DialogDescription>
              Pick which saved site survives, then choose which properties to keep in the merged result.
            </DialogDescription>
          </DialogHeader>

          {canMerge ? (
            <div className="flex flex-col gap-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedSites.map((site) => (
                  <label key={site.id} className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm">
                    <input
                      type="radio"
                      name="merge-target"
                      checked={mergeTargetId === site.id}
                      onChange={() => setMergeTarget(site.id)}
                      disabled={isPending}
                    />
                    <span className="flex flex-col gap-1">
                      <span className="font-medium">Keep this site record</span>
                      <span>{site.name}</span>
                      <span className="text-xs text-muted-foreground">{site.diveCount} dive log{site.diveCount === 1 ? "" : "s"}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="rounded-md border">
                <div className="grid grid-cols-[7rem_1fr_1fr] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <span>Property</span>
                  <span>{selectedSites[0].name}</span>
                  <span>{selectedSites[1].name}</span>
                </div>
                {mergeFields.map((field) => (
                  <div key={field.key} className="grid grid-cols-[7rem_1fr_1fr] items-center gap-2 border-b px-3 py-2 last:border-b-0">
                    <span className="text-xs font-medium">{field.label}</span>
                    {selectedSites.map((site) => (
                      <label key={site.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name={`merge-${field.key}`}
                          checked={(mergeChoices[field.key] ?? mergeTargetId) === site.id}
                          onChange={() => setMergeChoices((current) => ({ ...current, [field.key]: site.id }))}
                          disabled={isPending}
                        />
                        <span className="truncate">{displayValue(site, field.key)}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <MapPin className="mt-0.5 size-3.5 shrink-0" />
                All dive logs attached to the non-surviving site will be reassigned to the merged site.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canMerge || isPending} onClick={saveMerge}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Merge sites
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SiteFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: SiteFormState;
  onChange: (next: SiteFormState) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={value.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-location`}>Location</Label>
        <Input
          id={`${idPrefix}-location`}
          value={value.location}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, location: event.target.value })}
          placeholder="Dahab, Egypt"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-lat`}>Latitude</Label>
        <Input
          id={`${idPrefix}-lat`}
          inputMode="decimal"
          value={value.lat}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, lat: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-lng`}>Longitude</Label>
        <Input
          id={`${idPrefix}-lng`}
          inputMode="decimal"
          value={value.lng}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, lng: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label>Location on map</Label>
        <DiveSiteMap
          lat={optionalNumber(value.lat)}
          lng={optionalNumber(value.lng)}
          onPick={(lat, lng) => onChange({ ...value, lat: lat.toFixed(6), lng: lng.toFixed(6) })}
        />
        <p className="text-xs text-muted-foreground">Click the map to set this site&apos;s coordinates.</p>
      </div>
    </div>
  );
}
