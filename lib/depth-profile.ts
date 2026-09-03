// Depth-profile import for the dive form (plan Step 6).
//
// Deliberately framework-free and WITHOUT `import "server-only"`: the dive form parses a paste
// (or an uploaded file's text) in the browser so the user sees a malformed-input error before the
// server action is ever called, and `getDive`'s server-rendered detail view re-validates the JSONB
// it read back with the same guard. One parser, both sides.
//
// The parsed shape is the plan's "simple {time,depth}[] JSON array": `time` in MINUTES from the
// start of the dive (fractional allowed), `depth` in METRES. The raw text the user pasted is stored
// alongside it in `depth_profile_raw`, so a future parser change can re-derive the JSON.

export type DepthPoint = { time: number; depth: number };

export type DepthProfileParseResult =
  | { ok: true; points: DepthPoint[] }
  | { ok: false; error: string };

// Reading back a JSONB column: it was written by this parser, but the column is `unknown` to
// TypeScript and nothing stops a hand-edited row, so the detail view narrows it rather than casts.
export function isDepthProfile(value: unknown): value is DepthPoint[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        typeof (point as DepthPoint).time === "number" &&
        typeof (point as DepthPoint).depth === "number" &&
        Number.isFinite((point as DepthPoint).time) &&
        Number.isFinite((point as DepthPoint).depth),
    )
  );
}

// `12:30` / `1:02:30` (h:mm:ss) / `90` — a bare number is minutes, matching how dive-computer CSV
// exports label their first column ("Time (min)").
function parseTime(token: string): number | null {
  const parts = token.split(":");

  if (parts.length === 1) {
    const minutes = Number(parts[0]);
    return Number.isFinite(minutes) ? minutes : null;
  }

  if (parts.length > 3) return null;

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null;

  const [hours, minutes, seconds] =
    numbers.length === 3 ? numbers : [0, numbers[0], numbers[1]];

  return hours * 60 + minutes + seconds / 60;
}

function parseDepth(token: string): number | null {
  // Tolerates a trailing unit ("12.4 m", "12.4m") since that's what a copy-paste out of a
  // dive-computer app's table usually carries.
  const depth = Number(token.replace(/\s*(m|meters?|metres?)$/i, "").trim());
  return Number.isFinite(depth) ? depth : null;
}

function finalize(points: DepthPoint[]): DepthProfileParseResult {
  if (points.length < 2) {
    return { ok: false, error: "A depth profile needs at least two points." };
  }

  for (let i = 1; i < points.length; i++) {
    if (points[i].time < points[i - 1].time) {
      return {
        ok: false,
        error: `Depth profile times must not go backwards (point ${i + 1} is earlier than point ${i}).`,
      };
    }
  }

  return { ok: true, points };
}

// Minimal UDDF subset: the <waypoint> list inside a dive's <samples>. Parsed with regexes rather
// than a DOM/XML dependency -- we only need two leaf values per waypoint, and this has to run in
// the browser bundle too.
const UDDF_WAYPOINT = /<waypoint\b[^>]*>([\s\S]*?)<\/waypoint>/gi;
const UDDF_DIVETIME = /<divetime\b[^>]*>\s*([\d.]+)\s*<\/divetime>/i;
const UDDF_DEPTH = /<depth\b[^>]*>\s*([\d.]+)\s*<\/depth>/i;

function parseUddf(raw: string): DepthProfileParseResult {
  const points: DepthPoint[] = [];
  let index = 0;

  for (const match of raw.matchAll(UDDF_WAYPOINT)) {
    index += 1;
    const body = match[1];
    const divetime = body.match(UDDF_DIVETIME);
    const depth = body.match(UDDF_DEPTH);

    if (!divetime || !depth) {
      return {
        ok: false,
        error: `UDDF waypoint ${index} is missing a <divetime> or <depth> value.`,
      };
    }

    const seconds = Number(divetime[1]);
    const metres = Number(depth[1]);

    if (!Number.isFinite(seconds) || !Number.isFinite(metres)) {
      return { ok: false, error: `UDDF waypoint ${index} has a non-numeric divetime or depth.` };
    }

    // UDDF measures divetime in seconds and depth in metres.
    points.push({ time: seconds / 60, depth: metres });
  }

  if (points.length === 0) {
    return { ok: false, error: "No <waypoint> entries found in that UDDF document." };
  }

  return finalize(points);
}

function parseDelimited(raw: string): DepthProfileParseResult {
  const points: DepthPoint[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const columns = line.split(/[,;\t]|\s{1,}/).filter((column) => column !== "");
    if (columns.length < 2) {
      return { ok: false, error: `Line ${i + 1} needs a time and a depth, e.g. "3:00, 12.4".` };
    }

    const time = parseTime(columns[0]);
    const depth = parseDepth(columns[1]);

    // Leading non-numeric rows (a title line, a "time,depth" header) are skipped; anything
    // unparseable once real data has started is a hard error rather than a silent drop --
    // malformed input must fail the form.
    if (time === null || depth === null) {
      if (points.length === 0) continue;
      return {
        ok: false,
        error: `Line ${i + 1} is not a "time, depth" pair: "${line}".`,
      };
    }

    if (time < 0 || depth < 0) {
      return { ok: false, error: `Line ${i + 1} has a negative time or depth.` };
    }

    points.push({ time, depth });
  }

  return finalize(points);
}

/**
 * Parses pasted/uploaded depth-profile text. Returns a discriminated result rather than throwing:
 * the caller shows `error` inline and refuses to submit, so a malformed profile never reaches
 * `depth_profile` (the plan's "never partially writes depth_profile").
 */
export function parseDepthProfile(raw: string): DepthProfileParseResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, error: "Paste a depth profile first." };
  }

  return /<\s*(uddf|waypoint)\b/i.test(trimmed) ? parseUddf(trimmed) : parseDelimited(trimmed);
}
