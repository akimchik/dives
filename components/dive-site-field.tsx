"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Check, Loader2, MapPin, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { createDiveSiteAction, searchDiveSitesAction } from "@/app/actions/dives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DiveSiteRow } from "@/lib/dives";
import { cn } from "@/lib/utils";

// The form holds the raw field state; `toSiteSelection` below turns it into the shape
// `DiveInput.site` expects. Keeping the id and the typed name side by side is what lets a user
// either pick one of their existing sites or name a brand-new one without a mode switch.
export type DiveSiteFieldValue = {
  siteId: number | null;
  name: string;
  location: string;
  lat: string;
  lng: string;
};

export const emptyDiveSite: DiveSiteFieldValue = {
  siteId: null,
  name: "",
  location: "",
  lat: "",
  lng: "",
};

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A picked site is sent by id; a name typed but never explicitly created is sent as a name, and
 * `findOrCreateDiveSite` resolves it (create-or-reuse) inside the dive's own transaction — so a
 * rolled-back dive never leaves an orphaned site behind.
 */
export function toSiteSelection(value: DiveSiteFieldValue) {
  if (value.siteId !== null) return { id: value.siteId };
  if (!value.name.trim()) return null;

  return {
    name: value.name.trim(),
    location: value.location.trim() || null,
    lat: optionalNumber(value.lat),
    lng: optionalNumber(value.lng),
  };
}

export function DiveSiteField({
  value,
  onChange,
}: {
  value: DiveSiteFieldValue;
  onChange: (next: DiveSiteFieldValue) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [suggestions, setSuggestions] = useState<DiveSiteRow[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, startCreating] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  const query = value.name.trim();
  const isResolved = value.siteId !== null;

  // Debounced so a fast typist fires one lookup, not one per keystroke; `cancelled` guards against
  // an earlier, slower response overwriting a newer one.
  useEffect(() => {
    if (isResolved) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await searchDiveSitesAction(query || undefined);
        if (!cancelled) setSuggestions(rows);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isResolved]);

  // Clicking anywhere outside dismisses the listbox; without this it would stay open over the rest
  // of the form after the user moves on.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  function select(site: DiveSiteRow) {
    onChange({
      siteId: site.id,
      name: site.name,
      location: site.location ?? "",
      lat: site.lat === null ? "" : String(site.lat),
      lng: site.lng === null ? "" : String(site.lng),
    });
    setIsOpen(false);
  }

  function clear() {
    onChange(emptyDiveSite);
    setIsOpen(false);
  }

  // The explicit "Create dive site" path: saves the site immediately so it is reusable from the
  // autocomplete on the next dive, even if this form is abandoned before submit.
  function create() {
    const name = value.name.trim();
    if (!name) return;

    startCreating(async () => {
      const result = await createDiveSiteAction({
        name,
        location: value.location.trim() || null,
        lat: optionalNumber(value.lat),
        lng: optionalNumber(value.lng),
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      select(result.site);
      toast.success(`Saved dive site "${result.site.name}".`);
    });
  }

  const exactMatch = suggestions.some(
    (site) => site.name.toLowerCase() === query.toLowerCase(),
  );
  const canCreate = !isResolved && query.length > 0 && !exactMatch;

  return (
    <div className="flex flex-col gap-3" ref={containerRef}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>Dive site</Label>

        <div className="relative">
          <Input
            id={inputId}
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search your sites, or type a new name"
            value={value.name}
            // Editing the name detaches it from the previously picked site: the text no longer
            // necessarily identifies that row, so the id must not silently win at submit time.
            onChange={(event) => {
              onChange({ ...value, siteId: null, name: event.target.value });
              setIsOpen(true);
            }}
            onFocus={() => !isResolved && setIsOpen(true)}
            className={cn(isResolved && "pr-9")}
          />

          {isResolved ? (
            <span className="absolute inset-y-0 right-2 flex items-center">
              <Check className="size-4 text-muted-foreground" aria-label="Saved dive site" />
            </span>
          ) : null}
        </div>

        {isOpen && suggestions.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching dive sites"
            className="z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {suggestions.map((site) => (
              <li key={site.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={site.id === value.siteId}
                  onClick={() => select(site)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{site.name}</span>
                  {site.location ? (
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {site.location}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {isResolved ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Using saved site
            {value.location ? ` · ${value.location}` : ""}
            {value.lat && value.lng ? ` · ${value.lat}, ${value.lng}` : ""}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <X /> Change
          </Button>
        </div>
      ) : (
        // Details for a site that doesn't exist yet. Left visible (rather than behind a toggle) so
        // the GPS fields the spec calls for are discoverable while naming a new site.
        <div className="grid gap-3 rounded-md border border-dashed border-border p-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 sm:col-span-3">
            <Label htmlFor={`${inputId}-location`}>Site location</Label>
            <Input
              id={`${inputId}-location`}
              placeholder="Dahab, Egypt"
              value={value.location}
              onChange={(event) => onChange({ ...value, location: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${inputId}-lat`}>Latitude</Label>
            <Input
              id={`${inputId}-lat`}
              inputMode="decimal"
              placeholder="28.5091"
              value={value.lat}
              onChange={(event) => onChange({ ...value, lat: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${inputId}-lng`}>Longitude</Label>
            <Input
              id={`${inputId}-lng`}
              inputMode="decimal"
              placeholder="34.5136"
              value={value.lng}
              onChange={(event) => onChange({ ...value, lng: event.target.value })}
            />
          </div>
          <div className="flex items-end sm:col-span-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canCreate || isCreating}
              onClick={create}
            >
              {isCreating ? <Loader2 className="animate-spin" /> : <Plus />}
              Create dive site
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
