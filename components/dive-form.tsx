"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Star } from "lucide-react";
import { toast } from "sonner";

import { createDiveAction, updateDiveAction } from "@/app/actions/dives";
import { DepthProfileField } from "@/components/depth-profile-field";
import {
  DiveSiteField,
  emptyDiveSite,
  toSiteSelection,
  type DiveSiteFieldValue,
} from "@/components/dive-site-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { parseDepthProfile } from "@/lib/depth-profile";
import { toDateTimeLocalValue, trimNumeric } from "@/lib/dive-format";
import type { DiveInput, DiveRecord } from "@/lib/dives";
import { cn } from "@/lib/utils";

// Radix's Select has no concept of an empty value (an empty-string SelectItem throws), so
// "not recorded" needs its own sentinel that is mapped back to null on submit.
const NONE = "__none__";

const ENTRY_TYPES = ["Shore", "Boat", "Liveaboard", "Pier / jetty", "Drift"];
const SUIT_TYPES = [
  "Skin / rash guard",
  "Wetsuit 3mm",
  "Wetsuit 5mm",
  "Wetsuit 7mm",
  "Semi-dry",
  "Drysuit",
];
const INTENSITIES = ["None", "Mild", "Moderate", "Strong"];

type FormState = {
  occurredAt: string;
  site: DiveSiteFieldValue;
  maxDepth: string;
  avgDepth: string;
  bottomTimeMinutes: string;
  waterTemp: string;
  visibility: string;
  gasMix: string;
  tankInfo: string;
  weight: string;
  suitType: string;
  buddy: string;
  diveShop: string;
  current: string;
  surge: string;
  weather: string;
  entryType: string;
  notes: string;
  rating: number | null;
  depthProfileRaw: string;
};

function blankState(): FormState {
  return {
    occurredAt: toDateTimeLocalValue(new Date()),
    site: emptyDiveSite,
    maxDepth: "",
    avgDepth: "",
    bottomTimeMinutes: "",
    waterTemp: "",
    visibility: "",
    gasMix: "",
    tankInfo: "",
    weight: "",
    suitType: NONE,
    buddy: "",
    diveShop: "",
    current: NONE,
    surge: NONE,
    weather: "",
    entryType: NONE,
    notes: "",
    rating: null,
    depthProfileRaw: "",
  };
}

function stateFromDive(dive: DiveRecord): FormState {
  const text = (value: string | null) => value ?? "";
  const choice = (value: string | null) => value ?? NONE;

  return {
    occurredAt: toDateTimeLocalValue(dive.occurred_at),
    site: {
      siteId: dive.dive_site_id,
      name: text(dive.site_name),
      location: text(dive.site_location),
      lat: dive.site_lat === null ? "" : String(dive.site_lat),
      lng: dive.site_lng === null ? "" : String(dive.site_lng),
    },
    // numeric(5,2) arrives from pg as "12.40"; trimNumeric makes it editable as "12.4".
    maxDepth: trimNumeric(dive.max_depth) ?? "",
    avgDepth: trimNumeric(dive.avg_depth) ?? "",
    bottomTimeMinutes: dive.bottom_time_minutes === null ? "" : String(dive.bottom_time_minutes),
    waterTemp: trimNumeric(dive.water_temp) ?? "",
    visibility: trimNumeric(dive.visibility) ?? "",
    gasMix: text(dive.gas_mix),
    tankInfo: text(dive.tank_info),
    weight: trimNumeric(dive.weight) ?? "",
    suitType: choice(dive.suit_type),
    buddy: text(dive.buddy),
    diveShop: text(dive.dive_shop),
    current: choice(dive.current),
    surge: choice(dive.surge),
    weather: text(dive.weather),
    entryType: choice(dive.entry_type),
    notes: text(dive.notes),
    rating: dive.rating,
    depthProfileRaw: text(dive.depth_profile_raw),
  };
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function optionalChoice(value: string): string | null {
  return value === NONE ? null : value;
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function RatingField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm leading-none font-medium">Rating</legend>
      <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1 pt-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
            // Clicking the current rating clears it -- otherwise a mis-click could never be undone
            // back to "unrated".
            onClick={() => onChange(value === star ? null : star)}
            className="rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <Star
              className={cn(
                "size-5 transition-colors",
                value !== null && star <= value
                  ? "fill-foreground text-foreground"
                  : "text-muted-foreground/50",
              )}
            />
          </button>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">
          {value === null ? "Not rated" : `${value}/5`}
        </span>
      </div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ChoiceField({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not recorded</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DiveForm({ dive }: { dive?: DiveRecord }) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => (dive ? stateFromDive(dive) : blankState()));
  const [isPending, startTransition] = useTransition();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((previous) => ({ ...previous, [key]: value }));

  // Parsed on every keystroke so the error (and the preview chart) track the textarea live, and so
  // `canSubmit` below can refuse a malformed profile before the action is ever called.
  const profileResult = useMemo(
    () => (state.depthProfileRaw.trim() ? parseDepthProfile(state.depthProfileRaw) : null),
    [state.depthProfileRaw],
  );

  const profileIsInvalid = profileResult !== null && !profileResult.ok;
  const canSubmit = Boolean(state.occurredAt) && !profileIsInvalid && !isPending;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Belt and braces: the submit button is already disabled in this state, but a keyboard Enter
    // on a text input must not slip past it. A malformed profile never reaches the server, so
    // `depth_profile` is never partially written.
    if (profileIsInvalid) {
      toast.error(profileResult.error);
      return;
    }

    const input: DiveInput = {
      site: toSiteSelection(state.site),
      occurredAt: new Date(state.occurredAt),
      maxDepth: optionalNumber(state.maxDepth),
      avgDepth: optionalNumber(state.avgDepth),
      bottomTimeMinutes: optionalNumber(state.bottomTimeMinutes),
      waterTemp: optionalNumber(state.waterTemp),
      visibility: optionalNumber(state.visibility),
      gasMix: optionalText(state.gasMix),
      tankInfo: optionalText(state.tankInfo),
      weight: optionalNumber(state.weight),
      suitType: optionalChoice(state.suitType),
      buddy: optionalText(state.buddy),
      diveShop: optionalText(state.diveShop),
      current: optionalChoice(state.current),
      surge: optionalChoice(state.surge),
      weather: optionalText(state.weather),
      entryType: optionalChoice(state.entryType),
      notes: optionalText(state.notes),
      rating: state.rating,
      depthProfile: profileResult?.ok ? profileResult.points : null,
      depthProfileRaw: optionalText(state.depthProfileRaw),
    };

    startTransition(async () => {
      const result = dive
        ? await updateDiveAction(dive.id, input)
        : await createDiveAction(input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(dive ? "Dive updated." : "Dive logged.");
      // refresh() must come BEFORE push(): it invalidates the client Router Cache, so the
      // navigation that follows is forced to fetch fresh data instead of serving a snapshot of
      // this route already cached from earlier in the session (push-then-refresh raced on this --
      // push could resolve from the stale cache before refresh got a chance to invalidate it).
      router.refresh();
      router.push(`/dives/${result.id}`);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>When &amp; where</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="occurredAt" label="Date & time">
            <Input
              id="occurredAt"
              type="datetime-local"
              required
              value={state.occurredAt}
              onChange={(event) => set("occurredAt", event.target.value)}
            />
          </Field>

          <DiveSiteField value={state.site} onChange={(next) => set("site", next)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="maxDepth" label="Max depth (m)">
            <Input
              id="maxDepth"
              inputMode="decimal"
              placeholder="27.4"
              value={state.maxDepth}
              onChange={(event) => set("maxDepth", event.target.value)}
            />
          </Field>
          <Field id="avgDepth" label="Average depth (m)">
            <Input
              id="avgDepth"
              inputMode="decimal"
              placeholder="14.8"
              value={state.avgDepth}
              onChange={(event) => set("avgDepth", event.target.value)}
            />
          </Field>
          <Field id="bottomTimeMinutes" label="Bottom time (min)">
            <Input
              id="bottomTimeMinutes"
              inputMode="numeric"
              placeholder="48"
              value={state.bottomTimeMinutes}
              onChange={(event) => set("bottomTimeMinutes", event.target.value)}
            />
          </Field>
          <Field id="waterTemp" label="Water temp (°C)">
            <Input
              id="waterTemp"
              inputMode="decimal"
              placeholder="24.5"
              value={state.waterTemp}
              onChange={(event) => set("waterTemp", event.target.value)}
            />
          </Field>
          <Field id="visibility" label="Visibility (m)">
            <Input
              id="visibility"
              inputMode="decimal"
              placeholder="18"
              value={state.visibility}
              onChange={(event) => set("visibility", event.target.value)}
            />
          </Field>
          <ChoiceField
            id="entryType"
            label="Entry type"
            value={state.entryType}
            options={ENTRY_TYPES}
            placeholder="Not recorded"
            onChange={(next) => set("entryType", next)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gear &amp; gas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="gasMix" label="Gas mix">
            <Input
              id="gasMix"
              placeholder="EAN32"
              value={state.gasMix}
              onChange={(event) => set("gasMix", event.target.value)}
            />
          </Field>
          <Field id="tankInfo" label="Cylinder">
            <Input
              id="tankInfo"
              placeholder="12L steel, 200 bar"
              value={state.tankInfo}
              onChange={(event) => set("tankInfo", event.target.value)}
            />
          </Field>
          <Field id="weight" label="Weight (kg)">
            <Input
              id="weight"
              inputMode="decimal"
              placeholder="6"
              value={state.weight}
              onChange={(event) => set("weight", event.target.value)}
            />
          </Field>
          <ChoiceField
            id="suitType"
            label="Suit"
            value={state.suitType}
            options={SUIT_TYPES}
            placeholder="Not recorded"
            onChange={(next) => set("suitType", next)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conditions &amp; company</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <ChoiceField
            id="current"
            label="Current"
            value={state.current}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("current", next)}
          />
          <ChoiceField
            id="surge"
            label="Surge"
            value={state.surge}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("surge", next)}
          />
          <Field id="weather" label="Weather">
            <Input
              id="weather"
              placeholder="Sunny, light chop"
              value={state.weather}
              onChange={(event) => set("weather", event.target.value)}
            />
          </Field>
          <Field id="buddy" label="Buddy / dive guide">
            <Input
              id="buddy"
              placeholder="Sam Okafor"
              value={state.buddy}
              onChange={(event) => set("buddy", event.target.value)}
            />
          </Field>
          <Field id="diveShop" label="Dive shop / operator">
            <Input
              id="diveShop"
              placeholder="Blue Hole Divers"
              value={state.diveShop}
              onChange={(event) => set("diveShop", event.target.value)}
            />
          </Field>
          <RatingField value={state.rating} onChange={(next) => set("rating", next)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Log</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="notes" label="Notes">
            <Textarea
              id="notes"
              rows={4}
              placeholder="Turtles on the shallow shelf, thermocline at 18m."
              value={state.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
          </Field>

          <DepthProfileField
            value={state.depthProfileRaw}
            onChange={(next) => set("depthProfileRaw", next)}
            result={profileResult}
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {isPending ? <Loader2 className="animate-spin" /> : <Save />}
          {dive ? "Save changes" : "Log dive"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => router.push(dive ? `/dives/${dive.id}` : "/dives")}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
