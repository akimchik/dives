import type { DepthPoint } from "@/lib/depth-profile";
import type { DiveInput } from "@/lib/dives";

export type SuuntoDiveProfilePoint = {
  time: number;
  timestamp: string;
  depth: number | null;
  temperature: number | null;
  tankPressure: number | null;
  gasConsumption: number | null;
  gasConsumptionRate: number | null;
};

export type SuuntoDiveProfile = {
  source: "suunto";
  version: 1;
  workoutKey: string;
  startedAt: string | null;
  durationMinutes: number | null;
  maxDepth: number | null;
  averageDepth: number | null;
  waterTemperature: number | null;
  waterTemperatureLow: number | null;
  tankStartPressure: number | null;
  tankEndPressure: number | null;
  tankSizeLitres: number | null;
  gasMix: string | null;
  location: { lat: number; lng: number } | null;
  points: SuuntoDiveProfilePoint[];
  depthProfile: DepthPoint[];
  summary: Record<string, unknown>;
};

export type SuuntoProfileCompileResult =
  | { ok: true; profile: SuuntoDiveProfile; draftDive: Partial<DiveInput> }
  | { ok: false; error: string };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function celsiusFromKelvin(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null) return null;
  // Suunto SML temperatures in observed exports are Kelvin-like values (e.g. 293.02). Keep already
  // Celsius-shaped values intact so tests/fixtures can use simpler numbers.
  const celsius = number > 170 ? number - 273.15 : number;
  return Math.round(celsius * 10) / 10;
}

function barFromPascal(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null) return null;
  // Observed SML cylinder pressure is in pascals (18,460,938 ~= 184.6 bar). Preserve already bar-
  // shaped values for synthetic fixtures and future exporter changes.
  const bar = number > 1000 ? number / 100000 : number;
  return Math.round(bar * 10) / 10;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Mirrors Prometheus's rate(gas_used[1m]): for each point, the average bar/min drop in tank
// pressure since the earliest sample within the trailing 1-minute window. Points are already
// ordered by time, so the window's start only ever moves forward -- one pass with a two-pointer
// walk instead of a per-point scan.
function computeGasConsumptionRate(points: SuuntoDiveProfilePoint[]): (number | null)[] {
  const windowMinutes = 1;
  let start = 0;
  return points.map((point, index) => {
    if (point.gasConsumption === null) return null;
    while (start < index && points[start].time < point.time - windowMinutes) start++;

    const windowStart = points[start];
    const elapsedMinutes = point.time - windowStart.time;
    if (windowStart.gasConsumption === null || elapsedMinutes <= 0) return null;

    return round((point.gasConsumption - windowStart.gasConsumption) / elapsedMinutes, 2);
  });
}

function sampleRecord(sampleWrapper: unknown): JsonRecord {
  const wrapper = asRecord(sampleWrapper);
  const attributes = asRecord(wrapper.Attributes);
  const sml = asRecord(attributes["suunto/sml"]);
  return asRecord(sml.Sample ?? wrapper.Sample ?? sampleWrapper);
}

function sampleTimestamp(sampleWrapper: unknown, sample: JsonRecord): string | null {
  const wrapper = asRecord(sampleWrapper);
  return isoString(
    sample.Time ??
      sample.Timestamp ??
      sample.DateTime ??
      sample.TimeISO8601 ??
      wrapper.TimeISO8601 ??
      wrapper.Time ??
      wrapper.Timestamp,
  );
}

function cylinderPressure(sample: JsonRecord): number | null {
  const cylinders = sample.Cylinders;
  if (!Array.isArray(cylinders)) return null;

  for (const cylinder of cylinders) {
    const pressure = barFromPascal(asRecord(cylinder).Pressure);
    if (pressure !== null) return pressure;
  }
  return null;
}

function summaryRecords(root: JsonRecord): JsonRecord[] {
  const summary = asRecord(root.Summary);
  const samples = summary.Samples;
  return Array.isArray(samples) ? samples.map(asRecord) : [];
}

function findDiveSummary(root: JsonRecord): JsonRecord {
  const merged: JsonRecord = {};
  const windows: unknown[] = [];

  for (const entry of summaryRecords(root)) {
    const attrs = asRecord(entry.Attributes);
    const sml = asRecord(attrs["suunto/sml"]);
    const sample = asRecord(sml.Sample ?? sml ?? entry.Sample);

    if (isRecord(sample.DiveHeader) && !isRecord(merged.DiveHeader)) merged.DiveHeader = sample.DiveHeader;
    if (isRecord(sample.DiveFooter) && !isRecord(merged.DiveFooter)) merged.DiveFooter = sample.DiveFooter;
    if (Array.isArray(sample.Windows)) windows.push(...sample.Windows);
    if (isRecord(sample.Header) && !isRecord(merged.Header)) merged.Header = sample.Header;
  }

  if (windows.length > 0) merged.Windows = windows;
  return merged;
}

function firstGasMix(summary: JsonRecord): string | null {
  const header = asRecord(summary.DiveHeader);
  const gases = header.Gases;
  if (!Array.isArray(gases)) return null;
  const oxygen = firstNumber(asRecord(gases[0]).Oxygen);
  if (oxygen === null) return null;
  return Math.round(oxygen) === 21 ? "Air" : `EAN${Math.round(oxygen)}`;
}

function degreesFromSuuntoCoordinate(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || number === 0) return null;
  const degrees = Math.abs(number) <= Math.PI ? (number * 180) / Math.PI : number;
  return round(degrees, 6);
}

function coordinatePair(record: JsonRecord): { lat: number; lng: number } | null {
  const lat = degreesFromSuuntoCoordinate(record.Latitude ?? record.latitude ?? record.Lat ?? record.lat);
  const lng = degreesFromSuuntoCoordinate(
    record.Longitude ?? record.longitude ?? record.Lng ?? record.lng ?? record.Lon ?? record.lon,
  );
  return lat === null || lng === null ? null : { lat, lng };
}

function firstDataLocation(root: JsonRecord): { lat: number; lng: number } | null {
  const dataSamples = asRecord(root.Data).Samples;
  const samples = Array.isArray(dataSamples) ? dataSamples : [];

  for (const wrapper of samples) {
    const sample = sampleRecord(wrapper);
    const routeOrigin = coordinatePair(asRecord(sample.DiveRouteOrigin));
    if (routeOrigin) return routeOrigin;

    const sampleLocation = coordinatePair(sample);
    if (sampleLocation) return sampleLocation;
  }

  return null;
}

function firstLocation(root: JsonRecord, summary: JsonRecord): { lat: number; lng: number } | null {
  const footer = asRecord(summary.DiveFooter);
  const stop = coordinatePair(asRecord(asRecord(footer.DiveLocation).Stop));
  const start = coordinatePair(asRecord(asRecord(footer.DiveLocation).Start));
  const dataLocation = firstDataLocation(root);

  // `LastKnownCoordinates` can be a stale watch/app location unrelated to a dive when the workout
  // itself has no GPS route (observed exports have zero workout positions and no dive route origin,
  // but a non-zero LastKnownCoordinates from elsewhere). Ignore it unless Suunto also provides a
  // workout-scoped route/location source.
  return stop ?? start ?? dataLocation;
}

function hasDiveMarkers(root: JsonRecord, diveSummary: JsonRecord): boolean {
  if (isRecord(diveSummary.DiveHeader) || isRecord(diveSummary.DiveFooter)) return true;
  const dataSamples = asRecord(root.Data).Samples;
  const samples = Array.isArray(dataSamples) ? dataSamples : [];
  return samples.some((entry) => {
    const sample = sampleRecord(entry);
    return "Depth" in sample || "Cylinders" in sample || "DiveEvents" in sample || "Events" in sample;
  });
}

export function isSuuntoDiveProfile(value: unknown): value is SuuntoDiveProfile {
  return (
    isRecord(value) &&
    value.source === "suunto" &&
    value.version === 1 &&
    typeof value.workoutKey === "string" &&
    Array.isArray(value.points) &&
    Array.isArray(value.depthProfile)
  );
}

function draftDiveFromSuuntoProfile(profile: SuuntoDiveProfile): Partial<DiveInput> {
  return {
    title: "Suunto dive",
    site: profile.location
      ? {
          name: `Suunto GPS ${profile.location.lat.toFixed(4)}, ${profile.location.lng.toFixed(4)}`,
          location: `${profile.location.lat}, ${profile.location.lng}`,
          lat: profile.location.lat,
          lng: profile.location.lng,
        }
      : null,
    occurredAt: profile.startedAt ?? new Date().toISOString(),
    maxDepth: profile.maxDepth,
    avgDepth: profile.averageDepth,
    bottomTimeMinutes: profile.durationMinutes === null ? null : Math.round(profile.durationMinutes),
    waterTemp: profile.waterTemperature,
    waterTempLow: profile.waterTemperatureLow,
    gasMix: profile.gasMix,
    startPressure: profile.tankStartPressure,
    endPressure: profile.tankEndPressure,
    cylinderSize: profile.tankSizeLitres,
    depthProfile: profile.depthProfile,
    depthProfileRaw: null,
  };
}

export function compileSuuntoDiveProfile(
  workoutKey: string,
  smlJson: unknown,
): SuuntoProfileCompileResult {
  const root = asRecord(smlJson);
  const dataSamples = asRecord(root.Data).Samples;
  if (!Array.isArray(dataSamples)) {
    return { ok: false, error: "Suunto SML data does not contain Data.Samples." };
  }

  const diveSummary = findDiveSummary(root);
  if (!hasDiveMarkers(root, diveSummary)) {
    return { ok: false, error: "Suunto workout does not look like a dive SML export." };
  }

  const header = asRecord(diveSummary.DiveHeader);
  const footer = asRecord(diveSummary.DiveFooter);
  const windows = Array.isArray(diveSummary.Windows) ? diveSummary.Windows.map(asRecord) : [];
  const window0 =
    windows.find((window) => window.Type === "Dive") ??
    windows.find((window) => window.Type === "Activity") ??
    windows[0] ??
    {};
  const footerGas = Array.isArray(footer.Gases) ? asRecord(footer.Gases[0]) : {};
  const headerGas = Array.isArray(header.Gases) ? asRecord(header.Gases[0]) : {};

  const startPressure = barFromPascal(firstNumber(footerGas.StartPressure, headerGas.StartPressure, headerGas.TankFillPressure));
  const endPressure = barFromPascal(firstNumber(footerGas.EndPressure, headerGas.EndPressure));
  const tankSizeLitres = firstNumber(headerGas.TankSize);
  const tankSize = tankSizeLitres === null ? null : round(tankSizeLitres * (tankSizeLitres < 1 ? 1000 : 1), 1);

  const rawPoints: SuuntoDiveProfilePoint[] = [];
  let firstTimestampMs: number | null = null;
  let previous: Omit<SuuntoDiveProfilePoint, "time" | "timestamp"> = {
    depth: null,
    temperature: null,
    tankPressure: null,
    gasConsumption: null,
    gasConsumptionRate: null,
  };

  for (const wrapper of dataSamples) {
    const sample = sampleRecord(wrapper);
    const timestamp = sampleTimestamp(wrapper, sample);
    if (!timestamp) continue;

    const depth = round(firstNumber(sample.Depth), 2);
    const temperature = celsiusFromKelvin(sample.Temperature);
    const tankPressure = cylinderPressure(sample);
    if (depth === null && temperature === null && tankPressure === null) continue;

    const ms = Date.parse(timestamp);
    if (firstTimestampMs === null) firstTimestampMs = ms;
    const time = Math.max(0, (ms - firstTimestampMs) / 60000);
    const gasConsumption =
      startPressure === null || tankPressure === null ? null : round(Math.max(0, startPressure - tankPressure), 1);

    previous = {
      depth: depth ?? previous.depth,
      temperature: temperature ?? previous.temperature,
      tankPressure: tankPressure ?? previous.tankPressure,
      gasConsumption: gasConsumption ?? previous.gasConsumption,
      gasConsumptionRate: null,
    };
    rawPoints.push({ time: round(time, 3) ?? 0, timestamp, ...previous });
  }

  computeGasConsumptionRate(rawPoints).forEach((rate, index) => {
    rawPoints[index].gasConsumptionRate = rate;
  });

  const depthProfile = rawPoints
    .filter((point): point is SuuntoDiveProfilePoint & { depth: number } => point.depth !== null)
    .map((point) => ({ time: point.time, depth: point.depth }));

  if (depthProfile.length < 2) {
    return { ok: false, error: "Suunto dive profile needs at least two depth samples." };
  }

  const temperatures = rawPoints.flatMap((point) => (point.temperature === null ? [] : [point.temperature]));
  const summaryDepth = Array.isArray(window0.Depth) ? asRecord(window0.Depth[0]) : {};
  const summaryTemperature = Array.isArray(window0.Temperature) ? asRecord(window0.Temperature[0]) : {};
  const maxDepth = round(
    firstNumber(window0.MaxDepth, summaryDepth.Max, Math.max(...depthProfile.map((p) => p.depth))),
    2,
  );
  const headerSummary = asRecord(diveSummary.Header);
  const averageDepth = round(firstNumber(window0.DepthAverage, window0.AverageDepth, summaryDepth.Avg, headerSummary.DepthAverage), 2);
  const durationSeconds = firstNumber(window0.DiveTime, window0.DiveTimeMax, headerSummary.DiveTime, headerSummary.DiveTimeMax, window0.Duration);
  const durationMinutes = durationSeconds === null ? null : round(durationSeconds / 60, 1);
  const startedAt = rawPoints[0]?.timestamp ?? null;
  const waterTemperature =
    temperatures.length > 0 ? round(temperatures[0], 1) : celsiusFromKelvin(summaryTemperature.Avg);
  const waterTemperatureLow = temperatures.length > 0 ? round(Math.min(...temperatures), 1) : null;

  const profile: SuuntoDiveProfile = {
    source: "suunto",
    version: 1,
    workoutKey,
    startedAt,
    durationMinutes,
    maxDepth,
    averageDepth,
    waterTemperature,
    waterTemperatureLow,
    tankStartPressure: startPressure,
    tankEndPressure: endPressure,
    tankSizeLitres: tankSize,
    gasMix: firstGasMix(diveSummary),
    location: firstLocation(root, diveSummary),
    points: rawPoints,
    depthProfile,
    summary: diveSummary,
  };

  return { ok: true, profile, draftDive: draftDiveFromSuuntoProfile(profile) };
}
