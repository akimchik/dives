import "server-only";

import type { DepthPoint } from "@/lib/depth-profile";
import type { DiveInput } from "@/lib/dives";
import { isDescentDevice } from "./descent-devices";
import { ataAtDepth } from "@/lib/gas-consumption";

export type GarminDiveProfilePoint = {
  time: number; // Offset from start in seconds
  timestamp: string; // ISO string
  depth: number | null;
  temperature: number | null;
};

export type GarminDiveProfile = {
  source: "garmin";
  version: 1;
  activityId: string;
  startedAt: string | null;
  durationMinutes: number | null;
  maxDepth: number | null;
  averageDepth: number | null;
  waterTemperature: number | null;
  surfaceTemperature: number | null;
  location: { lat: number; lng: number } | null;
  points: GarminDiveProfilePoint[];
  depthProfile: DepthPoint[];
  summary: Record<string, unknown>;
};

export type GarminProfileCompileResult =
  | { ok: true; profile: GarminDiveProfile; draftDive: Partial<DiveInput> }
  | { ok: false; error: string; reason?: "not_a_dive" | "not_descent" };

// Sub sport enum for diving
const SUB_SPORT_APNEA_DIVING = 37;
const SUB_SPORT_APNEA_HUNT = 43;

export function compileGarminProfile(
  activityId: string,
  fitMessages: any,
): GarminProfileCompileResult {
  const sessionMsg = fitMessages.sessionMesgs?.[0];
  if (!sessionMsg) {
    return { ok: false, error: "No session message found in FIT file" };
  }

  // Ensure it's a dive (not apnea)
  const subSport = sessionMsg.subSport;
  if (subSport === SUB_SPORT_APNEA_DIVING || subSport === SUB_SPORT_APNEA_HUNT) {
    return { ok: false, error: "Apnea dives are explicitly excluded", reason: "not_a_dive" };
  }

  // Ensure it's from a Descent device
  const deviceInfoMsgs = fitMessages.deviceInfoMesgs || [];
  let isDescent = false;
  for (const info of deviceInfoMsgs) {
    if (isDescentDevice({
      manufacturer: info.manufacturer,
      product: info.product,
      garminProduct: info.garminProduct,
    })) {
      isDescent = true;
      break;
    }
  }

  if (!isDescent) {
    return { ok: false, error: "Data is not from a Garmin Descent device", reason: "not_descent" };
  }

  const diveSettingsMsg = fitMessages.diveSettingsMesgs?.[0];
  const startTime = sessionMsg.startTime;
  const startedAt = startTime instanceof Date ? startTime.toISOString() : null;

  // FIT timestamps are usually Date objects if the SDK parsed them
  let durationMinutes: number | null = null;
  if (sessionMsg.totalTimerTime) {
    durationMinutes = sessionMsg.totalTimerTime / 60.0;
  }

  const maxDepth = sessionMsg.maxDepth || null;
  const averageDepth = sessionMsg.avgDepth || null;
  
  let lat: number | null = null;
  let lng: number | null = null;
  if (sessionMsg.startPositionLat && sessionMsg.startPositionLong) {
    lat = sessionMsg.startPositionLat * (180 / Math.pow(2, 31));
    lng = sessionMsg.startPositionLong * (180 / Math.pow(2, 31));
  }

  // Compile points
  const points: GarminDiveProfilePoint[] = [];
  const depthProfile: DepthPoint[] = [];
  const records = fitMessages.recordMesgs || [];
  
  let startTimestampMs = startTime instanceof Date ? startTime.getTime() : null;
  if (!startTimestampMs && records.length > 0 && records[0].timestamp instanceof Date) {
    startTimestampMs = records[0].timestamp.getTime();
  }

  for (const record of records) {
    if (record.timestamp instanceof Date && startTimestampMs) {
      const timeSecs = (record.timestamp.getTime() - startTimestampMs) / 1000;
      
      points.push({
        time: timeSecs,
        timestamp: record.timestamp.toISOString(),
        depth: record.depth ?? null,
        temperature: record.temperature ?? null,
      });

      if (typeof record.depth === "number") {
        depthProfile.push({ t: timeSecs, d: record.depth });
      }
    }
  }

  const profile: GarminDiveProfile = {
    source: "garmin",
    version: 1,
    activityId,
    startedAt,
    durationMinutes,
    maxDepth,
    averageDepth,
    waterTemperature: sessionMsg.minTemperature ?? null, // 1=salt, 0=fresh
    surfaceTemperature: diveSettingsMsg?.surfaceTemperature ?? null,
    location: lat !== null && lng !== null ? { lat, lng } : null,
    points,
    depthProfile,
    summary: sessionMsg,
  };

  const draftDive: Partial<DiveInput> = {};
  if (startedAt) {
    draftDive.date = startedAt.split("T")[0];
    draftDive.time = startedAt.split("T")[1].substring(0, 5);
  }
  if (maxDepth) draftDive.maxDepth = maxDepth;
  if (averageDepth) draftDive.averageDepth = averageDepth;
  if (durationMinutes) draftDive.durationMinutes = Math.round(durationMinutes);
  if (diveSettingsMsg?.waterType === 1) draftDive.waterType = "salt";
  if (diveSettingsMsg?.waterType === 0) draftDive.waterType = "fresh";

  return { ok: true, profile, draftDive };
}
