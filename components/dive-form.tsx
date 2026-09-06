"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitMerge, Loader2, Save, Star } from "lucide-react";
import { toast } from "sonner";

import { createDiveAction, recentCylindersAction, updateDiveAction } from "@/app/actions/dives";
import { createSuuntoDiveImportAction, mergeSuuntoDiveImportAction } from "@/app/actions/suunto";
import { Checkbox } from "@/components/ui/checkbox";
import { DepthProfileField } from "@/components/depth-profile-field";
import {
  DiveSiteField,
  emptyDiveSite,
  toSiteSelection,
  type DiveSiteFieldValue,
} from "@/components/dive-site-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { parseDepthProfile } from "@/lib/depth-profile";
import { toDateTimeLocalValue, trimNumeric } from "@/lib/dive-format";
import type { DiveInput, DiveRecord, RecentCylinder } from "@/lib/dives";
import { computeGasConsumption } from "@/lib/gas-consumption";
import { cn } from "@/lib/utils";

// Radix's Select has no concept of an empty value (an empty-string SelectItem throws), so
// "not recorded" needs its own sentinel that is mapped back to null on submit.
const NONE = "__none__";
const OTHER = "__other__";

// "Drift" = a drift dive: entered from a moving boat and carried by the current rather than
// anchored/fixed to one spot, so it gets its own entry type rather than folding into "Boat".
const ENTRY_TYPES = ["Shore", "Boat", "Liveaboard", "Pier / jetty", "Drift"];
const SUIT_TYPES = [
  "Skin / rash guard",
  "Shorty",
  "Wetsuit 3mm",
  "Wetsuit 5mm",
  "Wetsuit 7mm",
  "Semi-dry",
  "Drysuit",
];
const INTENSITIES = ["None", "Mild", "Moderate", "Strong"];
const WEIGHT_FEEDBACK = ["Underweight", "Perfect", "Overweight"];
const WATER_TYPES = ["Salt", "Fresh", "Brackish"];
const BODIES_OF_WATER = ["Ocean", "Lake", "Quarry", "River"];

export type SuuntoMergeCandidate = {
  id: number;
  title: string | null;
  occurredAt: string;
  maxDepth: string | null;
  bottomTimeMinutes: number | null;
  siteName: string | null;
};

type FormState = {
  title: string;
  occurredAt: string;
  site: DiveSiteFieldValue;
  maxDepth: string;
  avgDepth: string;
  bottomTimeMinutes: string;
  waterTemp: string;
  waterTempLow: string;
  airTemp: string;
  visibility: string;
  gasMix: string;
  tankInfo: string;
  cylinderSize: string;
  startPressure: string;
  endPressure: string;
  weight: string;
  weightFeedback: string;
  suitType: string;
  hood: boolean;
  gloves: boolean;
  boots: boolean;
  buddy: string;
  diveShop: string;
  current: string;
  surge: string;
  waves: string;
  weather: string;
  waterType: string;
  bodyOfWater: string;
  bodyOfWaterOther: string;
  entryType: string;
  notes: string;
  rating: number | null;
  depthProfileRaw: string;
};

function blankState(): FormState {
  return {
    title: "",
    occurredAt: toDateTimeLocalValue(new Date()),
    site: emptyDiveSite,
    maxDepth: "",
    avgDepth: "",
    bottomTimeMinutes: "",
    waterTemp: "",
    waterTempLow: "",
    airTemp: "",
    visibility: "",
    gasMix: "",
    tankInfo: "",
    cylinderSize: "",
    startPressure: "",
    endPressure: "",
    weight: "",
    weightFeedback: NONE,
    suitType: NONE,
    hood: false,
    gloves: false,
    boots: false,
    buddy: "",
    diveShop: "",
    current: NONE,
    surge: NONE,
    waves: NONE,
    weather: "",
    waterType: NONE,
    bodyOfWater: NONE,
    bodyOfWaterOther: "",
    entryType: NONE,
    notes: "",
    rating: null,
    depthProfileRaw: "",
  };
}

function stateFromDive(dive: DiveRecord): FormState {
  const text = (value: string | null) => value ?? "";
  const choice = (value: string | null) => value ?? NONE;
  // A body of water outside the fixed list (typed as free text last time) round-trips through
  // the "Other" option with its value preserved in the text field, rather than being lost.
  const bodyOfWaterChoice =
    dive.body_of_water && !BODIES_OF_WATER.includes(dive.body_of_water) ? OTHER : choice(dive.body_of_water);

  return {
    title: text(dive.title),
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
    waterTempLow: trimNumeric(dive.water_temp_low) ?? "",
    airTemp: trimNumeric(dive.air_temp) ?? "",
    visibility: trimNumeric(dive.visibility) ?? "",
    gasMix: text(dive.gas_mix),
    tankInfo: text(dive.tank_info),
    cylinderSize: trimNumeric(dive.cylinder_size) ?? "",
    startPressure: trimNumeric(dive.start_pressure) ?? "",
    endPressure: trimNumeric(dive.end_pressure) ?? "",
    weight: trimNumeric(dive.weight) ?? "",
    weightFeedback: choice(dive.weight_feedback),
    suitType: choice(dive.suit_type),
    hood: dive.hood ?? false,
    gloves: dive.gloves ?? false,
    boots: dive.boots ?? false,
    buddy: text(dive.buddy),
    diveShop: text(dive.dive_shop),
    current: choice(dive.current),
    surge: choice(dive.surge),
    waves: choice(dive.waves),
    weather: text(dive.weather),
    waterType: choice(dive.water_type),
    bodyOfWater: bodyOfWaterChoice,
    bodyOfWaterOther: bodyOfWaterChoice === OTHER ? (dive.body_of_water ?? "") : "",
    entryType: choice(dive.entry_type),
    notes: text(dive.notes),
    rating: dive.rating,
    depthProfileRaw: text(dive.depth_profile_raw),
  };
}

function stateFromDraft(draft: Partial<DiveInput>): FormState {
  const state = blankState();

  return {
    ...state,
    title: draft.title ?? state.title,
    occurredAt: draft.occurredAt ? toDateTimeLocalValue(new Date(draft.occurredAt)) : state.occurredAt,
    maxDepth: draft.maxDepth === null || draft.maxDepth === undefined ? "" : String(draft.maxDepth),
    avgDepth: draft.avgDepth === null || draft.avgDepth === undefined ? "" : String(draft.avgDepth),
    bottomTimeMinutes:
      draft.bottomTimeMinutes === null || draft.bottomTimeMinutes === undefined
        ? ""
        : String(draft.bottomTimeMinutes),
    waterTemp: draft.waterTemp === null || draft.waterTemp === undefined ? "" : String(draft.waterTemp),
    waterTempLow:
      draft.waterTempLow === null || draft.waterTempLow === undefined ? "" : String(draft.waterTempLow),
    airTemp: draft.airTemp === null || draft.airTemp === undefined ? "" : String(draft.airTemp),
    visibility: draft.visibility === null || draft.visibility === undefined ? "" : String(draft.visibility),
    gasMix: draft.gasMix ?? "",
    tankInfo: draft.tankInfo ?? "",
    cylinderSize:
      draft.cylinderSize === null || draft.cylinderSize === undefined ? "" : String(draft.cylinderSize),
    startPressure:
      draft.startPressure === null || draft.startPressure === undefined ? "" : String(draft.startPressure),
    endPressure: draft.endPressure === null || draft.endPressure === undefined ? "" : String(draft.endPressure),
    weight: draft.weight === null || draft.weight === undefined ? "" : String(draft.weight),
    weightFeedback: draft.weightFeedback ?? state.weightFeedback,
    suitType: draft.suitType ?? state.suitType,
    hood: draft.hood ?? state.hood,
    gloves: draft.gloves ?? state.gloves,
    boots: draft.boots ?? state.boots,
    buddy: draft.buddy ?? "",
    diveShop: draft.diveShop ?? "",
    current: draft.current ?? state.current,
    surge: draft.surge ?? state.surge,
    waves: draft.waves ?? state.waves,
    weather: draft.weather ?? "",
    waterType: draft.waterType ?? state.waterType,
    bodyOfWater: draft.bodyOfWater ?? state.bodyOfWater,
    entryType: draft.entryType ?? state.entryType,
    notes: draft.notes ?? "",
    rating: draft.rating ?? state.rating,
    depthProfileRaw: draft.depthProfileRaw ?? "",
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

// "Other" resolves to whatever was typed in the paired free-text field -- covers any body of
// water the fixed list doesn't name (per the TODO: "other(open text)").
function resolveBodyOfWater(state: FormState): string | null {
  if (state.bodyOfWater === OTHER) return optionalText(state.bodyOfWaterOther);
  return optionalChoice(state.bodyOfWater);
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

type ChoiceOption = string | { value: string; label: string };

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
  options: ChoiceOption[];
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
          {options.map((option) => {
            const { value: optionValue, label: optionLabel } =
              typeof option === "string" ? { value: option, label: option } : option;

            return (
              <SelectItem key={optionValue} value={optionValue}>
                {optionLabel}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function formatCylinderOption(option: RecentCylinder): string {
  const size = option.cylinderSize ? `${trimNumeric(option.cylinderSize)} L` : null;
  return [option.tankInfo, size].filter(Boolean).join(" · ") || "—";
}

function formatCandidate(candidate: SuuntoMergeCandidate): string {
  const date = new Date(candidate.occurredAt);
  const when = Number.isFinite(date.getTime()) ? date.toLocaleString() : candidate.occurredAt;
  const details = [
    candidate.siteName,
    candidate.maxDepth ? `${trimNumeric(candidate.maxDepth)} m` : null,
    candidate.bottomTimeMinutes === null ? null : `${candidate.bottomTimeMinutes} min`,
  ].filter(Boolean);

  return `${when}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

// Optional convenience, not a bound form field -- deliberately uncontrolled, so after a pick the
// trigger just shows that option's own label rather than needing to reset back to a placeholder.
function RecentCylinderPicker({
  onPick,
}: {
  onPick: (option: RecentCylinder) => void;
}) {
  const [options, setOptions] = useState<RecentCylinder[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    recentCylindersAction()
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!options || options.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Select
        onValueChange={(index) => {
          const option = options[Number(index)];
          if (option) onPick(option);
        }}
      >
        <SelectTrigger aria-label="Use a recent cylinder" className="h-8 w-auto text-xs">
          <SelectValue placeholder="Use a recent cylinder" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={index} value={String(index)}>
              {formatCylinderOption(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CheckField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="group/field flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

export function DiveForm({
  dive,
  draftDive,
  suuntoImportId,
  suuntoMergeCandidates = [],
  cancelHref,
  submitLabel,
}: {
  dive?: DiveRecord;
  draftDive?: Partial<DiveInput>;
  suuntoImportId?: number;
  suuntoMergeCandidates?: SuuntoMergeCandidate[];
  cancelHref?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const initialDepthProfile = dive?.depth_profile ?? draftDive?.depthProfile ?? null;
  const [state, setState] = useState<FormState>(() =>
    dive ? stateFromDive(dive) : draftDive ? stateFromDraft(draftDive) : blankState(),
  );
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(suuntoMergeCandidates[0]?.id ?? null);
  const [isPending, startTransition] = useTransition();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((previous) => ({ ...previous, [key]: value }));

  // Parsed on every keystroke so the error (and the preview chart) track the textarea live, and so
  // `canSubmit` below can refuse a malformed profile before the action is ever called.
  const profileResult = useMemo(
    () => (state.depthProfileRaw.trim() ? parseDepthProfile(state.depthProfileRaw) : null),
    [state.depthProfileRaw],
  );

  // Live preview only -- the rate itself is never stored, it's re-derived from the stored
  // pressures/cylinder/depth/time every time it's shown (form and detail page alike).
  const gasConsumption = useMemo(
    () =>
      computeGasConsumption({
        startPressure: optionalNumber(state.startPressure),
        endPressure: optionalNumber(state.endPressure),
        cylinderSize: optionalNumber(state.cylinderSize),
        avgDepth: optionalNumber(state.avgDepth),
        bottomTimeMinutes: optionalNumber(state.bottomTimeMinutes),
      }),
    [state.startPressure, state.endPressure, state.cylinderSize, state.avgDepth, state.bottomTimeMinutes],
  );

  const profileIsInvalid = profileResult !== null && !profileResult.ok;
  const canSubmit = Boolean(state.occurredAt) && !profileIsInvalid && !isPending;

  function validateProfile() {
    // Belt and braces: submit/merge buttons are already disabled in this state, but keyboard Enter
    // and dialog buttons must not slip past it. A malformed profile never reaches the server, so
    // `depth_profile` is never partially written.
    if (!profileIsInvalid) return true;
    toast.error(profileResult.error);
    return false;
  }

  function buildInput(): DiveInput {
    return {
      site: toSiteSelection(state.site),
      title: optionalText(state.title),
      occurredAt: new Date(state.occurredAt),
      maxDepth: optionalNumber(state.maxDepth),
      avgDepth: optionalNumber(state.avgDepth),
      bottomTimeMinutes: optionalNumber(state.bottomTimeMinutes),
      waterTemp: optionalNumber(state.waterTemp),
      waterTempLow: optionalNumber(state.waterTempLow),
      airTemp: optionalNumber(state.airTemp),
      visibility: optionalNumber(state.visibility),
      gasMix: optionalText(state.gasMix),
      tankInfo: optionalText(state.tankInfo),
      cylinderSize: optionalNumber(state.cylinderSize),
      startPressure: optionalNumber(state.startPressure),
      endPressure: optionalNumber(state.endPressure),
      weight: optionalNumber(state.weight),
      weightFeedback: optionalChoice(state.weightFeedback),
      suitType: optionalChoice(state.suitType),
      hood: state.hood,
      gloves: state.gloves,
      boots: state.boots,
      buddy: optionalText(state.buddy),
      diveShop: optionalText(state.diveShop),
      current: optionalChoice(state.current),
      surge: optionalChoice(state.surge),
      waves: optionalChoice(state.waves),
      weather: optionalText(state.weather),
      waterType: optionalChoice(state.waterType),
      bodyOfWater: resolveBodyOfWater(state),
      entryType: optionalChoice(state.entryType),
      notes: optionalText(state.notes),
      rating: state.rating,
      depthProfile: profileResult?.ok ? profileResult.points : state.depthProfileRaw.trim() ? null : initialDepthProfile,
      depthProfileRaw: optionalText(state.depthProfileRaw),
    };
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateProfile()) return;

    const input = buildInput();

    startTransition(async () => {
      const result =
        suuntoImportId !== undefined
          ? await createSuuntoDiveImportAction(suuntoImportId, input)
          : dive
            ? await updateDiveAction(dive.id, input)
            : await createDiveAction(input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(suuntoImportId !== undefined ? "Suunto dive saved." : dive ? "Dive updated." : "Dive logged.");
      // refresh() must come BEFORE push(): it invalidates the client Router Cache, so the
      // navigation that follows is forced to fetch fresh data instead of serving a snapshot of
      // this route already cached from earlier in the session (push-then-refresh raced on this --
      // push could resolve from the stale cache before refresh got a chance to invalidate it).
      router.refresh();
      if (suuntoImportId !== undefined && "nextImportId" in result && result.nextImportId !== null) {
        router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
      } else {
        router.push(`/dives/${result.id}`);
      }
    });
  }

  function mergeIntoExistingDive() {
    if (suuntoImportId === undefined || mergeTargetId === null) return;
    if (!validateProfile()) return;

    const input = buildInput();

    startTransition(async () => {
      const result = await mergeSuuntoDiveImportAction(suuntoImportId, mergeTargetId, input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success("Suunto dive merged into existing dive.");
      setMergeOpen(false);
      router.refresh();
      if ("nextImportId" in result && result.nextImportId !== null) {
        router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
      } else {
        router.push(`/dives/${result.id}`);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>When &amp; where</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="title" label="Title" hint="Optional -- defaults to the site name and date.">
            <Input
              id="title"
              placeholder="Night dive with the reef sharks"
              value={state.title}
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>

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
          <Field id="waterTemp" label="Water temp — surface (°C)">
            <Input
              id="waterTemp"
              inputMode="decimal"
              placeholder="24.5"
              value={state.waterTemp}
              onChange={(event) => set("waterTemp", event.target.value)}
            />
          </Field>
          <Field id="waterTempLow" label="Water temp — lowest (°C)">
            <Input
              id="waterTempLow"
              inputMode="decimal"
              placeholder="21.0"
              value={state.waterTempLow}
              onChange={(event) => set("waterTempLow", event.target.value)}
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
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
            <Field id="cylinderSize" label="Cylinder size (L)">
              <Input
                id="cylinderSize"
                inputMode="decimal"
                placeholder="12"
                value={state.cylinderSize}
                onChange={(event) => set("cylinderSize", event.target.value)}
              />
            </Field>
            <div className="flex flex-col justify-end gap-1.5 sm:col-span-2 lg:col-span-1">
              <RecentCylinderPicker
                onPick={(option) => {
                  setState((previous) => ({
                    ...previous,
                    tankInfo: option.tankInfo ?? previous.tankInfo,
                    cylinderSize: trimNumeric(option.cylinderSize) ?? previous.cylinderSize,
                  }));
                }}
              />
            </div>
            <Field id="startPressure" label="Start pressure (bar)">
              <Input
                id="startPressure"
                inputMode="decimal"
                placeholder="200"
                value={state.startPressure}
                onChange={(event) => set("startPressure", event.target.value)}
              />
            </Field>
            <Field id="endPressure" label="End pressure (bar)">
              <Input
                id="endPressure"
                inputMode="decimal"
                placeholder="50"
                value={state.endPressure}
                onChange={(event) => set("endPressure", event.target.value)}
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
              id="weightFeedback"
              label="Weighting"
              value={state.weightFeedback}
              options={WEIGHT_FEEDBACK}
              placeholder="Not recorded"
              onChange={(next) => set("weightFeedback", next)}
            />
            <ChoiceField
              id="suitType"
              label="Suit"
              value={state.suitType}
              options={SUIT_TYPES}
              placeholder="Not recorded"
              onChange={(next) => set("suitType", next)}
            />
          </div>

          {gasConsumption ? (
            <p className="text-xs text-muted-foreground" data-testid="gas-consumption-preview">
              {gasConsumption.gasUsedLiters.toFixed(0)} L used · SAC rate{" "}
              {gasConsumption.sacRateLitersPerMin.toFixed(1)} L/min
            </p>
          ) : null}

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <CheckField id="hood" label="Hood" checked={state.hood} onChange={(next) => set("hood", next)} />
            <CheckField
              id="gloves"
              label="Gloves"
              checked={state.gloves}
              onChange={(next) => set("gloves", next)}
            />
            <CheckField id="boots" label="Boots" checked={state.boots} onChange={(next) => set("boots", next)} />
          </div>
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
          <ChoiceField
            id="waves"
            label="Waves"
            value={state.waves}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("waves", next)}
          />
          <Field id="weather" label="Weather">
            <Input
              id="weather"
              placeholder="Sunny, light chop"
              value={state.weather}
              onChange={(event) => set("weather", event.target.value)}
            />
          </Field>
          <Field id="airTemp" label="Air temp (°C)">
            <Input
              id="airTemp"
              inputMode="decimal"
              placeholder="29"
              value={state.airTemp}
              onChange={(event) => set("airTemp", event.target.value)}
            />
          </Field>
          <ChoiceField
            id="waterType"
            label="Water type"
            value={state.waterType}
            options={WATER_TYPES}
            placeholder="Not recorded"
            onChange={(next) => set("waterType", next)}
          />
          <ChoiceField
            id="bodyOfWater"
            label="Body of water"
            value={state.bodyOfWater}
            options={[...BODIES_OF_WATER, { value: OTHER, label: "Other" }]}
            placeholder="Not recorded"
            onChange={(next) => set("bodyOfWater", next)}
          />
          {state.bodyOfWater === OTHER ? (
            <Field id="bodyOfWaterOther" label="Body of water — other">
              <Input
                id="bodyOfWaterOther"
                placeholder="Cenote"
                value={state.bodyOfWaterOther}
                onChange={(event) => set("bodyOfWaterOther", event.target.value)}
              />
            </Field>
          ) : null}
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
          {submitLabel ?? (dive ? "Save changes" : "Log dive")}
        </Button>
        {suuntoImportId !== undefined && suuntoMergeCandidates.length > 0 ? (
          <Button type="button" variant="outline" disabled={!canSubmit} onClick={() => setMergeOpen(true)}>
            <GitMerge />
            Merge into existing dive
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => router.push(cancelHref ?? (dive ? `/dives/${dive.id}` : "/dives"))}
        >
          Cancel
        </Button>
      </div>

      <Dialog open={mergeOpen} onOpenChange={(open) => !isPending && setMergeOpen(open)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Merge Suunto import into existing dive</DialogTitle>
            <DialogDescription>
              Pick the existing dive to keep. The reviewed fields on this page and the Suunto chart
              data will be saved onto that dive, then this staged import will be removed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
            {suuntoMergeCandidates.map((candidate, index) => (
              <label key={candidate.id} className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm">
                <input
                  type="radio"
                  name="suunto-merge-target"
                  checked={mergeTargetId === candidate.id}
                  onChange={() => setMergeTargetId(candidate.id)}
                  disabled={isPending}
                />
                <span className="flex flex-col gap-1">
                  <span className="font-medium">
                    {candidate.title || candidate.siteName || `Dive #${candidate.id}`}
                    {index === 0 ? <span className="ml-2 text-xs text-muted-foreground">closest by date</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatCandidate(candidate)}</span>
                </span>
              </label>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmit || mergeTargetId === null} onClick={mergeIntoExistingDive}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Merge into selected dive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
