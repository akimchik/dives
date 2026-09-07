"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Highlight } from "@/lib/json-highlight";
import { cn } from "@/lib/utils";

// Root + two levels open by default (e.g. root -> "Data" -> "Header"/"Samples"/"Footer"), so the
// SML shape is visible on load without dumping every sample point into the DOM.
const DEFAULT_EXPAND_DEPTH = 3;
const BASE_REVEAL_COUNT = 100;
const REVEAL_STEP = 200;
const MAX_AUTO_REVEAL = 2000;
// A real Suunto export runs to tens of thousands of JSON nodes (thousands of dive samples). A
// short/common query (e.g. a single letter) can match a large fraction of them, and naively
// force-opening every matched ancestor renders tens of thousands of components on one keystroke —
// measured to visibly freeze the tab. Two independent guards keep worst-case render size bounded
// regardless of how permissive the query is: a minimum query length (single characters never
// trigger auto-expand) and a hard cap on how many containers a search is allowed to force open.
const MIN_QUERY_LENGTH_FOR_EXPAND = 2;
const MAX_SEARCH_EXPAND_PATHS = 1500;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isContainer(value: unknown): value is Json[] | Record<string, Json> {
  return value !== null && typeof value === "object";
}

function entriesOf(value: Json[] | Record<string, Json>): [string, Json][] {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as [string, Json])
    : Object.entries(value);
}

function typeLabel(value: Json[] | Record<string, Json>): string {
  return Array.isArray(value) ? `Array(${value.length})` : `Object(${Object.keys(value).length})`;
}

// Single pass over the tree: which container paths must start open because a descendant matches
// the search query, and for arrays containing a match, how many leading items to reveal so the
// match isn't hidden behind the default reveal cap. Stops force-opening new paths once
// MAX_SEARCH_EXPAND_PATHS is hit (matches past that point still highlight if the user manually
// expands their container, they just aren't auto-revealed) -- this is what keeps a pathological
// query's render cost bounded.
function collectSearchState(
  value: Json,
  path: string,
  lowerQuery: string,
  openPaths: Set<string>,
  revealFloors: Map<string, number>,
): boolean {
  if (isContainer(value)) {
    let childMatched = false;
    for (const [key, child] of entriesOf(value)) {
      const childPath = `${path}.${key}`;
      const keyMatches = !Array.isArray(value) && key.toLowerCase().includes(lowerQuery);
      const descendantMatched = collectSearchState(child, childPath, lowerQuery, openPaths, revealFloors);

      if (keyMatches || descendantMatched) {
        childMatched = true;
        if (Array.isArray(value) && openPaths.size < MAX_SEARCH_EXPAND_PATHS) {
          const floor = Math.min(Number(key) + 1, MAX_AUTO_REVEAL);
          revealFloors.set(path, Math.max(revealFloors.get(path) ?? 0, floor));
        }
      }
    }
    if (childMatched && openPaths.size < MAX_SEARCH_EXPAND_PATHS) openPaths.add(path);
    return childMatched;
  }

  return String(value).toLowerCase().includes(lowerQuery);
}

function JsonLeaf({ value, query }: { value: null | boolean | number | string; query: string }) {
  if (value === null)
    return (
      <span className="text-muted-foreground">
        <Highlight text="null" query={query} />
      </span>
    );
  if (typeof value === "boolean")
    return (
      <span className="text-amber-600 dark:text-amber-400">
        <Highlight text={String(value)} query={query} />
      </span>
    );
  if (typeof value === "number")
    return (
      <span className="text-blue-600 dark:text-blue-400">
        <Highlight text={String(value)} query={query} />
      </span>
    );
  return (
    <span className="text-emerald-700 dark:text-emerald-400">
      &quot;
      <Highlight text={value} query={query} />
      &quot;
    </span>
  );
}

function JsonNode({
  label,
  value,
  path,
  depth,
  query,
  openPaths,
  revealFloors,
  overrides,
  onToggle,
  revealOverrides,
  onReveal,
}: {
  label: string | null;
  value: Json;
  path: string;
  depth: number;
  query: string;
  openPaths: Set<string>;
  revealFloors: Map<string, number>;
  overrides: Map<string, boolean>;
  onToggle: (path: string, currentlyOpen: boolean) => void;
  revealOverrides: Map<string, number>;
  onReveal: (path: string, count: number) => void;
}) {
  if (!isContainer(value)) {
    return (
      <div className="flex items-start gap-1 py-0.5 pl-5 font-mono text-xs leading-relaxed">
        {label !== null ? (
          <span className="text-foreground/80">
            <Highlight text={label} query={query} />:
          </span>
        ) : null}
        <JsonLeaf value={value} query={query} />
      </div>
    );
  }

  // Search wins over a stale manual collapse: without openPaths.has(path) short-circuiting first,
  // collapsing a node by hand and then searching for something inside it would leave the match
  // force-computed as findable but rendered as if it weren't there. onToggle can still close it
  // (see below) for the duration of the current query.
  const defaultOpen = openPaths.has(path) || depth < DEFAULT_EXPAND_DEPTH;
  const isOpen = overrides.get(path) ?? defaultOpen;
  const isArray = Array.isArray(value);
  const entries = entriesOf(value);

  const revealFloor = revealFloors.get(path) ?? 0;
  const revealCount = Math.max(revealOverrides.get(path) ?? BASE_REVEAL_COUNT, revealFloor);
  const visibleEntries = isArray ? entries.slice(0, revealCount) : entries;
  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <div className="font-mono text-xs leading-relaxed">
      <button
        type="button"
        onClick={() => onToggle(path, isOpen)}
        aria-expanded={isOpen}
        className="flex w-full items-start gap-1 rounded py-0.5 pl-1 text-left hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
          aria-hidden
        />
        {label !== null ? (
          <span className="text-foreground/80">
            <Highlight text={label} query={query} />:
          </span>
        ) : null}
        <span className="text-muted-foreground">{typeLabel(value)}</span>
      </button>

      {isOpen ? (
        <div className="ml-3 border-l border-border/60 pl-2">
          {visibleEntries.map(([key, child]) => (
            <JsonNode
              key={key}
              label={isArray ? null : key}
              value={child}
              path={`${path}.${key}`}
              depth={depth + 1}
              query={query}
              openPaths={openPaths}
              revealFloors={revealFloors}
              overrides={overrides}
              onToggle={onToggle}
              revealOverrides={revealOverrides}
              onReveal={onReveal}
            />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => onReveal(path, revealCount + REVEAL_STEP)}
              className="py-1 pl-5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show {Math.min(REVEAL_STEP, hiddenCount)} more ({hiddenCount} left)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function JsonTreeView({ data, query }: { data: unknown; query: string }) {
  const trimmedQuery = query.trim();

  const { openPaths, revealFloors } = useMemo(() => {
    const openPaths = new Set<string>();
    const revealFloors = new Map<string, number>();
    if (trimmedQuery.length >= MIN_QUERY_LENGTH_FOR_EXPAND) {
      collectSearchState(data as Json, "root", trimmedQuery.toLowerCase(), openPaths, revealFloors);
    }
    return { openPaths, revealFloors };
  }, [data, trimmedQuery]);

  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [revealOverrides, setRevealOverrides] = useState<Map<string, number>>(new Map());

  // A manual expand/collapse only applies to the query that was active when it happened -- a new
  // query recomputes which paths search wants open, so stale overrides from a previous query
  // (which could otherwise mask a real match under a now-irrelevant collapse) are dropped with it.
  // Adjusting state during render (React's documented pattern for "resetting state when a prop
  // changes") rather than in an Effect, since an Effect would cause an extra render pass.
  const [queryForOverrides, setQueryForOverrides] = useState(trimmedQuery);
  if (trimmedQuery !== queryForOverrides) {
    setQueryForOverrides(trimmedQuery);
    setOverrides(new Map());
    setRevealOverrides(new Map());
  }

  const onToggle = (path: string, currentlyOpen: boolean) => {
    setOverrides((prev) => new Map(prev).set(path, !currentlyOpen));
  };

  const onReveal = (path: string, count: number) => {
    setRevealOverrides((prev) => new Map(prev).set(path, count));
  };

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3">
      <JsonNode
        label={null}
        value={data as Json}
        path="root"
        depth={0}
        query={trimmedQuery}
        openPaths={openPaths}
        revealFloors={revealFloors}
        overrides={overrides}
        onToggle={onToggle}
        revealOverrides={revealOverrides}
        onReveal={onReveal}
      />
    </div>
  );
}
