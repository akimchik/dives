import type { DiveSnapshot } from "./dives";

export const MISSING_PADI_TAG = "missing-padi";
export const MISSING_SUUNTO_TAG = "missing-suunto";

export type IntegrationConnections = {
  padiConnected: boolean;
  suuntoConnected: boolean;
};

type TaggableDive = Pick<DiveSnapshot, "tags" | "padi_dive_id" | "suunto_workout_key">;

// "missing-padi"/"missing-suunto" are never written to the tags column -- they're derived here
// from padi_dive_id/suunto_workout_key plus the user's current integration status, so a dive that
// gets synced later (or an integration that gets connected/disconnected) never needs a backfill to
// stay correct.
export function effectiveTags(dive: TaggableDive, connections: IntegrationConnections): string[] {
  const tags = [...dive.tags];
  if (connections.padiConnected && dive.padi_dive_id === null) tags.push(MISSING_PADI_TAG);
  if (connections.suuntoConnected && dive.suunto_workout_key === null) tags.push(MISSING_SUUNTO_TAG);
  return tags;
}

export type TagCount = { tag: string; count: number };

// Tag-cloud aggregation runs in JS over an already-fetched dive list rather than a second SQL
// query: a personal logbook's dive count is small enough that this is cheap, and it guarantees the
// cloud's counts and the filtered list below always agree (same effectiveTags() call, same input).
export function buildTagCloud(dives: TaggableDive[], connections: IntegrationConnections): TagCount[] {
  const counts = new Map<string, number>();

  for (const dive of dives) {
    for (const tag of effectiveTags(dive, connections)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
